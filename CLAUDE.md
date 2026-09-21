# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> See `README.md` for the product overview (capabilities, deployment topology, verification numbers) and `AGENTS.md` for the project convention cheatsheet. This file documents the **code architecture** a future agent needs to be productive quickly.

## Working conventions

- **Stop early on user-required actions.** When something can only be resolved by the user (env failures like WSL Docker integration dropping the socket, missing permissions that need `sudo` from a TTY, decisions only they can make), stop immediately — explain what's stuck and state exactly what they need to decide or run. Don't burn tool calls probing for workarounds before reporting back.

## What this is

AgentLuoss is an enterprise agent platform: a React web UI talks to a Go HTTP gateway, which fans out via gRPC to six Go backend services plus a pool of Node sidecars (`agent-runtime`) that host `pi` SDK `AgentSession`s. The architectural model is **stateful sessions on stateless protocol edges** — all runtime intelligence (LLM calls, tool execution, conversation memory) lives inside the Node sidecar; all platform orchestration (lifecycle, scheduling, auth, quotas, events, file artifacts) lives in Go services.

```
web/React ─HTTP+SSE─► cmd/gateway (Go :8080, gin)
                       │ gRPC (outgoing ctx carries x-user-id/role/ip)
                       ├─► iam       :9091  accounts/RBAC/JWT (HS256, KEY=JWT_SECRET)
                       ├─► task      :9092  scheduler, session lock, event pipeline ←─┐
                       ├─► artifact  :9093  workspace files (path-traversal-safe)     │ gRPC
                       ├─► modelmgt  :9094  provider/model/key vault, models.json      │
                       ├─► usage     :9095  metering, quota, audit consumer           │
                       └─► caps      :9096  MCP servers + skills (admin CRUD)         │
                                                                                       │
              agent-runtime ×N  (Node :9100, pi SDK SessionPool)  ─── gRPC ────────────┘
                       │
                       ├─ cwd = /data/workspaces/<userId>   (directory isolation; NOT a sandbox)
                       ├─ sessions = /data/sessions/<sessionId>.jsonl
                       └─ LLM via ModelRuntime reading /data/config/models.json
```

Shared infra: PostgreSQL (one schema per service) + Redis (registry, event streams, session locks, audit stream).

## Module map (where to look)

```
proto/                         six .proto files; generated Go in proto/gen/ (commit after `make proto`)
internal/<svc>/                one directory per service — store (SQL), server (gRPC impl), sometimes adapters
internal/{jwtx,auditx,cryptx,db,grpcx}    cross-service libraries (see below)
cmd/<svc>/main.go              thin entrypoint; envOr() for config, grpcx.Serve() to start
services/agent-runtime/src/    Node sidecar (TypeScript, ESM)
web/src/                       React SPA (no router lib; hash-based in App.tsx)
deploy/                        compose, Dockerfiles, e2e/load/zip scripts
openspec/                      spec-driven change workflow (schema: spec-driven; empty for this repo)
```

### Cross-service Go libraries (`internal/`)

| Package | Used by | Purpose |
|---|---|---|
| `jwtx` | `iam` (sign), `gateway` (verify) | HS256 access tokens (`Claims{UserID, Role, Typ}`); shared `JWT_SECRET` env var |
| `auditx` | every service that needs audit | Fire-and-forget `XADD audit`; `usage` is the consumer |
| `cryptx` | `modelmgt` (provider API keys), `caps` (MCP env) | AES-GCM with `KEY_MASTER`-derived key; nonce-prefixed base64 |
| `db` | every Go service with PG | `pgxpool` connect-with-retry + embed.FS migration loader; each service migrates only its own `migrations/` |
| `grpcx` | every Go service | `Serve(port, register)` — health + reflection + graceful shutdown |

### Service responsibilities

- **`gateway`** (`internal/gateway/`): gin routes under `/api/v1`; `authMiddleware` reads JWT and sets `user_id`/`role` in gin context; `outCtx` forwards them as gRPC metadata (`x-user-id`, `x-user-role`, `x-user-ip`). Serves the React build from `WEB_DIR` with SPA fallback. SSE handler at `internal/gateway/tasks.go:259` (`taskEvents`) is the canonical example of the Last-Event-ID replay pattern.
- **`iam`**: user/department CRUD, JWT signing, `Bootstrap(ctx, admin, pass)` creates the first admin on first start (env: `ADMIN_USERNAME`/`ADMIN_PASSWORD`).
- **`task`** (`internal/task/`): the domain hub.
  - `server.go` — gRPC service; `CreateTask`/`SendPrompt`/`SteerTask`/`AbortTask`/`StreamEvents` for clients; `RegisterRuntime`/`RuntimeHeartbeat`/`PushEvents` for runtimes.
  - `registry.go` — runtime registry (Redis), least-loaded `Pick()`, session lock `lock:session:<taskID>`.
  - `pipeline.go` — Redis-Stream-backed event log (7d TTL); `Ingest` assigns seq + persists + fan-outs to in-memory subscribers; `Subscribe` returns a buffered chan; `Replay` returns events with `seq > since`.
  - `runtimes.go` — gRPC client cache keyed by `runtime_id`.
  - `caps_adapter.go` / `usage_adapter.go` — fail-open clients to caps/usage (interface in server.go lines 45–74).
- **`modelmgt`**: provider/model CRUD with API keys stored via `cryptx`. `Render(ctx)` writes `/data/config/{models.json,auth.json}` and notifies runtimes via `ReloadConfig` (RuntimeClients-style — task-svc is the one that actually calls runtimes; modelmgt only writes files).
- **`usage`**: consumes `audit` and usage events from `usage.*` Redis streams; aggregates per user/day/model; quota check on `SendPrompt`. `DEFAULT_MONTHLY_LIMIT_USD` env default.
- **`caps`**: MCP servers (`stdio|http|sse`, env values AES-GCM encrypted in DB) and Skills (zip upload → `/data/skills/<id>/`, parses `SKILL.md` frontmatter, scopes by department/role/all). `GetEffectiveCaps` resolves the user's visible caps and **unions expert-bound caps** — failures are fail-open.
- **`artifact`**: workspace file CRUD under `/data/workspaces`; canonical path-traversal protection at `internal/artifact/server.go` (look for `EvalSymlinks` + prefix assertion — there is a unit test, run it after edits).

## Key data flows

### Prompt round-trip

1. Web `POST /api/v1/tasks/:id/messages` → gateway `sendPrompt` → `task.SendPrompt` (`internal/task/server.go:328`).
2. Quota check (`usage.Allowed`) — fail-open if `quota` is nil or usage service is unreachable.
3. Session lock `lock:session:<taskID>` via Redis `SETNX` (15-min TTL as safety net; released on `agent_settled`).
4. `ensureSession` (server.go:236): first try `task.RuntimeID` (sticky), else `registry.Pick`; call `caps.EffectiveCaps(userID, expertID)` to get the **decrypted** MCP env and skill paths for the session; `CreateSession` on the chosen runtime (resumes from `session_path` if non-empty).
5. `Prompt` on the runtime (fire-and-forget; errors become `error` events).
6. Status flips to `running`; runtime streams events via `PushEvents` → `pipeline.Ingest` (assigns seq, persists to `stream:task:<id>`, fan-out to live subscribers) → `onEvent` (server.go:507) updates status / extracts `message_end` usage / updates context-usage Redis key.
7. `agent_settled` releases the session lock.

### SSE replay

Client opens `GET /api/v1/tasks/:id/events?access_token=…` (browsers can't set Authorization headers on EventSource — the gateway accepts `?access_token=` as a fallback, see `internal/gateway/server.go:174`). Server sends `Last-Event-ID: <seq>` on reconnect; gateway parses it into `sinceSeq`; task-svc `StreamEvents` first `Subscribe`s, then `Replay`s, then forwards live events skipping already-seen seqs. Pipeline `Ingest` uses non-blocking sends; slow consumers drop live events and recover via replay.

### Caps resolution (fail-open)

`task.ensureSession` calls `caps.EffectiveCaps(userID, expertID)` every time it creates or resumes a session. If caps-svc is unreachable, log a warning and proceed with no extensions — **never block task creation**. MCP env values are decrypted by caps-svc (env values are AES-GCM in DB, write-only via `UpsertMcpServer`; the `ListMcpServers` REST response masks env to `""`). Effective caps also **union in expert member caps** (caps/server.go:297) — admin scopes an expert at creation time, and any user who picks that expert gets its bound MCP/skill IDs added to their effective set.

## Conventions worth knowing

- **proto-loader is camelCase** (Node side, `keepCase: false`): gRPC field names appear in TS/JS as `taskId`, `modelId`, `sessionPath`, not `task_id`. Backend code that builds TS/JS requests must follow this.
- **PG epoch math**: `(extract(epoch from col)*1000)::bigint` everywhere pgx hands timestamps to int64 — pgx won't decode `numeric` directly into Go int64.
- **Fail-open for usage and caps**: both adapters are optional (`env USAGE_ADDR=""` / `CAPS_ADDR=""`); when nil, `noopUsage`/`noopCaps` allow everything. Real adapters also swallow errors during prompt flow.
- **Secret write-only pattern** (modelmgt + caps): secrets are stored encrypted and decrypted only at the seam where they're consumed (models.json render, `GetEffectiveCaps`). REST `List*` responses send masked values so the UI never sees them.
- **Effective caps recomputed per session**: admin changes to MCP/skills only affect new sessions; long-lived sessions are not migrated. Idle eviction (30 min, runtime-side) is the natural reload point.
- **Directory isolation only**: workspaces are `/data/workspaces/<userId>` — no sandbox. Path-traversal defense is the only boundary; documented as a v1 acceptance in `PLAN.md` with per-user-container as the upgrade path.
- **Actor metadata**: `mdGet(ctx, "x-user-id"/"x-user-role"/"x-user-ip")` (task/server.go:596) is the standard way to read caller identity inside a gRPC handler. Export the helper with `MDGet` for cross-package reuse.
- **envOr + log.Fatal**: every cmd uses the `envOr(k, d)` local helper (some copy it, some reuse via `mustAtoi`); failures are `log.Fatal` at boot. `cmd/gateway/main.go` is the simplest template.
- **Gateway admin path quirk**: the admin group is registered with an empty prefix (`authed.Group("", a.requireAdmin())`), so routes are written as their **full** path under `/api/v1` (e.g. `/admin/mcp`, `/admin/users`) — do not strip the `/admin` prefix.

## Build, lint, test

Common commands (the Makefile is the source of truth — these are the targets you actually invoke):

```
make build        # go build ./...
make test         # go test ./...           # only some packages have tests today
make proto        # regenerate proto/gen after editing proto/*.proto
make tidy         # go mod tidy
make up / down / ps   # docker compose in deploy/
```

Service-specific:

```
# Go: targeted test (some packages have tests; jwtx/caps/scope/artifact are the ones with coverage)
go test ./internal/jwtx/... ./internal/caps/... ./internal/artifact/...

# agent-runtime: build + typecheck
cd services/agent-runtime && npm install && npm run build
# smoke (needs local pi config at ~/.pi/agent/{auth,models}.json)
node services/agent-runtime/scripts/smoke.mjs /tmp/rt-smoke craft
# caps/skill injection smoke
node services/agent-runtime/scripts/smoke-caps.mjs

# web
cd web && npm install && npm run build   # tsc -b && vite build; output -> web/dist

# full stack e2e + load (inside backend network):
docker run --rm --network agentluoss_backend -v $PWD:/w -w /w \
  -e ZAI_API_KEY=<key> -e http_proxy= -e https_proxy= \
  node:24-bookworm-slim node deploy/e2e.mjs http://172.28.0.11:8080
node deploy/load.mjs 100 http://172.28.0.11:8080
```

## Deployment notes

Two compose files in `deploy/`:

- `docker-compose.yml` — adapted for this dev host (kernel lacks iptables DNAT and docker embedded DNS): static IPs `172.28.0.0/24`, `network_mode: host` for runtimes (so LLM egress works), every container has its proxy env neutralized.
- `docker-compose.standard.yml` — the "normal host" version (service-name DNS, published :8080, bridge network). Use this when deploying elsewhere.

`GATEWAY_PORT` env (default 18090) overrides the published port in the standard compose to avoid collisions on shared hosts.

The `Dockerfile.gosvc` is a multi-stage build that produces a single image with all seven Go binaries plus the React build, dispatched by `ENTRYPOINT ["/entry.sh"] <service-name>`.
