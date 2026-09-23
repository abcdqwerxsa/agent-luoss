# AgentLuoss 下一步优化：生产韧性三件套 + 可观测性

> 状态：已确认（A + B，GitHub Actions，turn 超时 30min 可配）。实现细节已探明，待批准执行。

## Context

平台功能面完整，但生产就绪度有四个缺口：

1. **无 CI** — `make test` 只有手动跑，PR 合并无门禁。
2. **优雅停机不完整** — `grpcx.Serve` 已有 `GracefulStop`，但对长连接流（runtime 的 `PushEvents`、gateway 的 `StreamEvents`）会无限等待，Docker 10s stop 超时后直接 SIGKILL，等于没停；gateway 是裸 `http.ListenAndServe`，SIGTERM 砍断所有 SSE。
3. **无 turn 看门狗** — 任务状态只在收到 `agent_settled`/`error` 事件时退出 `running`；runtime 挂死/LLM 无响应 → 任务永久 `running`（负载测试 97/100 的尾部即此）。
4. **无可观测性** — 无 `/metrics`、无 pprof，出问题是黑盒。

用户已确认：全做（A1 CI + A2 停机 + A3 看门狗 + B 指标）；CI 用 GitHub Actions；turn 超时默认 30 分钟（env 可配），超时置 `failed` + 合成 error 事件，用户可追问恢复。

## 关键探索结论（决定实现方式）

- **挂钟信号**：`task.tasks.updated_at` 只在 turn 开始时刷新（`SetStatus("running")`）——合法的 31 分钟长 turn 会被误杀，**不能用作超时判据**。正确信号是「最后事件时间」：所有 pi 事件都过 `Pipeline.Ingest`（`internal/task/pipeline.go`），流式 turn 期间 token 事件持续不断，「30 分钟无任何事件」= 真挂死。在 Ingest 的 Redis pipeline 里顺手 `SET task:lastev:<id>`（TTL 7d 同 eventTTL，自动清理）。
- **超时语义已知权衡**：单次工具执行超 30 分钟（如大文件处理）无中间事件也会被判超时——已向用户说明并确认（可调大 env）。
- **grpcx 是单一修改点**：6 个 gRPC 服务的 main.go 都走 `grpcx.Serve`，停机修复 + 指标埋点在一处生效。
- **compose 锚点**：两个 compose 文件都有 `x-go-env: &goenv` 锚点，加一行 `METRICS_ADDR` 覆盖全部 Go 服务（各容器独立网络命名空间，统一内网端口 `:9100` 不冲突，不发布到宿主机）。
- 会话锁 TTL 已是 15 分钟（`AcquireSessionLock(..., 15*time.Minute)`），看门狗 30 分钟兜底与其自洽。
- `prometheus/client_golang` 未引入（已验证 `go get` 可用，v1.24.1）。
- CI 命令：Go `go build ./... && go test ./...`（proto/gen 已提交，无需 protoc）；web `npx tsc -b`（vite 模板 noEmit 纯检查）；runtime `npm run build`（tsc 检查+emit）。go 1.27.1，Node 24。

## Approach

### A1. CI — `.github/workflows/ci.yml`（新文件）

push/PR 到 main 触发，两个 job：
- `go`：actions/setup-go@v5（go-version-file: go.mod）→ `go build ./...` → `go test ./...`
- `node`：setup-node@v4，两步：`web/` 与 `services/agent-runtime/` 各自 `npm ci` + tsc 构建。

### A2. 优雅停机

- `internal/grpcx/server.go`：信号处理改为 `GracefulStop` 带 8s 截止（< Docker 默认 10s stop_grace），超时 `s.Stop()` 强停——长连接流不再拖死停机。
- `cmd/gateway/main.go`：改用 `http.Server` + `signal.NotifyContext` + `srv.Shutdown`（8s 超时）。SSE 客户端被断是安全的：前端已有 Last-Event-ID 重连回放。

### A3. Turn 看门狗

- `internal/task/pipeline.go`：`Ingest` 的 Redis pipeline 加一行 `pipe.Set(ctx, "task:lastev:"+ev.TaskId, <ms>, eventTTL)`。
- `internal/task/store.go`：新增 `ListRunning(ctx)` — `SELECT id, runtime_id, updated_at(ms) FROM task.tasks WHERE status='running'`（running 集合很小，无需新索引）。
- `internal/task/watchdog.go`（新文件）：`Server.StartWatchdog(timeout)` 起 goroutine，每 60s tick：
  - `ListRunning` → 每任务读 `task:lastev:<id>`（缺失时回退 `updated_at`）→ 超 `timeout` 则：best-effort 向 runtime 发 `Abort`（复用 AbortTask 的调用模式）→ 释放会话锁 → `SetStatus(failed)` → synth `error` 事件（消息注明超时时长）→ 计数器 +1；
  - 同一个 tick 顺手更新指标：running 数、健康 runtime 数、runtime 池 active/max。
- `cmd/task/main.go`：`TURN_TIMEOUT_MIN` env（默认 30）→ `srv.StartWatchdog(...)`。

### B. 可观测性 — `internal/metricsx`（新包）+ 接线

- `internal/metricsx/metricsx.go`：`Start(addr)`（空 = 关闭，现有部署零行为变化）— `/metrics`（promhttp）+ `/debug/pprof/*`；`UnaryInterceptor()`（按 method/code 的请求计数 + 时延直方图；长流不拦截，注释说明）；`HTTPMiddleware`（按 route/method/code）。
- `internal/grpcx/server.go`：`Serve` 内 `metricsx.StartFromEnv()`（METRICS_ADDR）+ `grpc.ChainUnaryInterceptor(metricsx.UnaryInterceptor())` — **6 个服务 main 零改动**。
- `internal/gateway/server.go`：build() 中间件链加 metrics；`cmd/gateway/main.go` 调 `metricsx.StartFromEnv()`。
- `internal/task/watchdog.go` 内注册：`task_running`、`task_runtimes`、`task_runtime_sessions{active,max}`、`task_turn_timeouts_total`。
- 两个 compose 文件 `x-go-env` 锚点加 `METRICS_ADDR: ":9100"`。不部署 Prometheus 本体（抓取方后续接入；不发布宿主机端口）。

## Files to modify

| 文件 | 动作 |
|---|---|
| `.github/workflows/ci.yml` | 新增（A1） |
| `internal/grpcx/server.go` | 改：停机截止 + 指标接线（A2/B） |
| `cmd/gateway/main.go` | 改：http.Server 优雅停机 + metrics（A2/B） |
| `internal/gateway/server.go` | 改：gin metrics 中间件（B） |
| `internal/task/pipeline.go` | 改：lastev 键（A3） |
| `internal/task/store.go` | 改：ListRunning（A3） |
| `internal/task/watchdog.go` | 新增（A3 + task 指标） |
| `cmd/task/main.go` | 改：TURN_TIMEOUT_MIN（A3） |
| `internal/metricsx/metricsx.go` | 新增（B） |
| `deploy/docker-compose.yml`、`deploy/docker-compose.standard.yml` | 改：锚点加 METRICS_ADDR（B） |
| `go.mod`/`go.sum` | 新依赖 prometheus/client_golang |

## Reuse

- 超时清理复用 `AbortTask` 的 runtime 调用模式（`registry.Get` → `clients.Get` → `cl.Abort`）与 `synth()` 合成事件。
- 指标复用 grpcx.Serve 单点接线，避免改 6 个 main。
- compose 复用 `x-go-env` 锚点单点加 env。

## Steps

- [x] A1：`.github/workflows/ci.yml`（go job + node job）
- [x] B：`internal/metricsx` 包 + grpcx/gateway 接线 + compose METRICS_ADDR
- [x] A2：grpcx 停机截止；gateway http.Server 停机
- [x] A3：pipeline lastev → store ListRunning → watchdog → task main 接线
- [x] `go build ./... && go test ./...` 全绿；`go vet ./...`
- [ ] web/runtime tsc 本地跑一遍确认 CI 命令可用
- [ ] 提交（分 4 个 commit：ci / shutdown / watchdog / metrics，或按用户习惯一次）

## Verification

1. `go build ./... && go test ./...` — 编译 + 既有测试（jwtx/task router/artifact/caps）通过。
2. 看门狗单测逻辑自检：将 timeout 设为秒级 + 手造 `running` 任务（无 lastev 键、updated_at 回溯）→ 断言被置 failed + 出现合成 error 事件；有新事件的跑动任务不被误杀。
3. 本机 compose 起栈：`curl :9100/metrics`（容器内）出现 grpc/http 指标；`docker compose restart task` 观察 8s 内干净退出日志。
4. push 后观察 GitHub Actions 两个 job 绿。
