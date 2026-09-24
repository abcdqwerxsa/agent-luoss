// agent-runtime: Node sidecar hosting pi AgentSessions behind gRPC.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as os from "node:os";
import { EventBus } from "./eventbus.js";
import { SessionPool } from "./pool.js";
import type { Mode } from "./prompts.js";

const env = (k: string, d: string) => process.env[k] || d;

const PROTO_DIR = env("PROTO_DIR", "../../proto");
const PORT = parseInt(env("PORT", "9100"), 10);
const RUNTIME_ID = env("RUNTIME_ID", os.hostname());
const ADVERTISE_ADDR = env("ADVERTISE_ADDR", `${os.hostname()}:${PORT}`);
const TASK_ADDR = env("TASK_ADDR", "127.0.0.1:9092");
const MODELS_PATH = env("MODELS_PATH", "/data/config/models.json");
const AUTH_PATH = env("AUTH_PATH", "/data/config/auth.json");
const SESSIONS_DIR = env("SESSIONS_DIR", "/data/sessions");
const WORKSPACES_DIR = env("WORKSPACES_DIR", "/data/workspaces");
const AGENT_DIR = env("AGENT_DIR", "/data/runtime/agent");
const MAX_SESSIONS = parseInt(env("MAX_SESSIONS", "200"), 10);
const IDLE_TTL_MS = parseInt(env("IDLE_TTL_MS", String(30 * 60 * 1000)), 10);

// proto-loader delivers enums as names ("TASK_MODE_ASK") with enums:String;
// accept numeric values too for safety.
const MODES: Record<string | number, Mode> = {
  1: "ask", 2: "craft", 3: "plan",
  TASK_MODE_ASK: "ask", TASK_MODE_CRAFT: "craft", TASK_MODE_PLAN: "plan",
};

async function main() {
  const bus = new EventBus(PROTO_DIR, TASK_ADDR, RUNTIME_ID, ADVERTISE_ADDR);
  const pool = new SessionPool({
    modelsPath: MODELS_PATH,
    authPath: AUTH_PATH,
    sessionsDir: SESSIONS_DIR,
    agentDir: AGENT_DIR,
    maxSessions: MAX_SESSIONS,
    idleTtlMs: IDLE_TTL_MS,
    bus,
  });
  try {
    await pool.initModelRuntime();
    console.log(`[runtime] model runtime ready (${MODELS_PATH})`);
  } catch (err: any) {
    console.warn("[runtime] model runtime init failed:", err.message);
  }
  bus.setActiveProvider(() => ({ active: pool.count(), max: pool.max() }));
  bus.startRegistry(5000);
  pool.startSweep(60_000);

  const def = protoLoader.loadSync(`${PROTO_DIR}/runtime.proto`, {
    includeDirs: [PROTO_DIR],
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const impl = {
    createSession: async (call: any, cb: any) => {
      const r = call.request;
      const mode = MODES[r.mode] ?? "craft";
      try {
        const workspacePath = r.workspacePath || `${WORKSPACES_DIR}/${r.userId}`;
        const caps = {
          mcp: (r.mcpServers || []).map((m: any) => ({
            id: m.id as string,
            name: m.name as string,
            transport: m.transport as string,
            command: m.command,
            args: m.args ?? [],
            env: m.env ?? {},
            url: m.url,
          })),
          skills: (r.skills || []).map((k: any) => ({
            name: k.name as string,
            description: k.description ?? "",
            path: k.path as string,
          })),
        };
        const res = await pool.create({
          taskId: r.taskId,
          userId: r.userId,
          mode,
          provider: r.model?.provider || "",
          modelId: r.model?.modelId || "",
          workspacePath,
          sessionPath: r.sessionPath || "",
          caps,
        });
        cb(null, { sessionId: res.sessionId, sessionPath: res.sessionPath, resumed: res.resumed });
      } catch (err: any) {
        cb({ code: grpc.status.FAILED_PRECONDITION, message: err.message });
      }
    },

    prompt: async (call: any, cb: any) => {
      let session = pool.get(call.request.taskId);
      if (!session) return cb({ code: grpc.status.NOT_FOUND, message: "session not in pool (re-create to resume)" });
      const images = (call.request.images || []).map((i: any) => ({
        type: "image" as const,
        source: { type: "base64" as const, mediaType: i.mediaType, data: i.data },
      }));
      const behavior = call.request.streamingBehavior || undefined;
      if (session.isStreaming && !behavior) {
        return cb({ code: grpc.status.INVALID_ARGUMENT, message: "streaming; set streaming_behavior (steer|follow_up)" });
      }
      // Optional per-turn permission mode switch: rebuild the session
      // (same session file) with the new toolset + system prompt.
      const newMode = call.request.mode;
      if (newMode === "ask" || newMode === "craft" || newMode === "plan") {
        if (session.isStreaming) {
          return cb({ code: grpc.status.INVALID_ARGUMENT, message: "cannot switch mode while streaming" });
        }
        if (pool.modeOf(call.request.taskId) !== newMode) {
          try {
            session = await pool.switchMode(call.request.taskId, newMode);
          } catch (err: any) {
            return cb({ code: grpc.status.FAILED_PRECONDITION, message: `mode switch failed: ${err?.message ?? err}` });
          }
          bus.push({
            taskId: call.request.taskId,
            type: "mode_switched",
            payload: JSON.stringify({ mode: newMode }),
            timestamp: Date.now(),
          });
        }
      }
      // Optional per-turn model override: applied before this prompt via
      // session.setModel (conversation history is preserved; pi keeps the
      // change session-only). Rejected while streaming.
      const ov = call.request.model;
      if (ov && (ov.provider || ov.modelId)) {
        if (session.isStreaming) {
          return cb({ code: grpc.status.INVALID_ARGUMENT, message: "cannot switch model while streaming" });
        }
        const m = pool.modelRuntime ? pool.modelRuntime.getModel(ov.provider, ov.modelId) : null;
        if (!m) {
          return cb({ code: grpc.status.INVALID_ARGUMENT, message: `model not found: ${ov.provider}/${ov.modelId}` });
        }
        try {
          if (m !== session.model) await session.setModel(m);
        } catch (err: any) {
          return cb({ code: grpc.status.FAILED_PRECONDITION, message: `set model failed: ${err?.message ?? err}` });
        }
        bus.push({
          taskId: call.request.taskId,
          type: "model_switched",
          payload: JSON.stringify({ provider: ov.provider, modelId: ov.modelId }),
          timestamp: Date.now(),
        });
      }
      // fire-and-forget: events stream to task via eventbus; errors become events
      session
        .prompt(call.request.message, { images: images.length ? images : undefined, streamingBehavior: behavior } as any)
        .catch((err: any) => bus.push({ taskId: call.request.taskId, type: "error", payload: JSON.stringify({ message: err?.message ?? String(err) }), timestamp: Date.now() }));
      cb(null, { accepted: true });
    },

    steer: async (call: any, cb: any) => {
      const session = pool.get(call.request.taskId);
      if (!session) return cb({ code: grpc.status.NOT_FOUND, message: "session not in pool" });
      try {
        await session.steer(call.request.message);
        cb(null, {});
      } catch (err: any) {
        cb({ code: grpc.status.FAILED_PRECONDITION, message: err.message });
      }
    },

    abort: async (call: any, cb: any) => {
      const session = pool.get(call.request.taskId);
      if (!session) return cb({ code: grpc.status.NOT_FOUND, message: "session not in pool" });
      try {
        await session.abort();
        cb(null, {});
      } catch (err: any) {
        cb({ code: grpc.status.INTERNAL, message: err.message });
      }
    },

    getSessionState: async (call: any, cb: any) => {
      const session = pool.get(call.request.taskId);
      if (!session) return cb(null, { exists: false });
      cb(null, {
        exists: true,
        isStreaming: session.isStreaming,
        modelId: session.model?.id ?? "",
        sessionId: session.sessionId,
        messageCount: session.messages.length,
      });
    },

    closeSession: async (call: any, cb: any) => {
      pool.close(call.request.taskId);
      cb(null, {});
    },

    heartbeat: async (_call: any, cb: any) => {
      cb(null, { runtimeId: RUNTIME_ID, activeSessions: pool.count(), maxSessions: pool.max() });
    },

    reloadConfig: async (_call: any, cb: any) => {
      try {
        await pool.initModelRuntime();
        cb(null, { ok: true, error: "" });
      } catch (err: any) {
        cb(null, { ok: false, error: err.message });
      }
    },
  };

  const server = new grpc.Server();
  server.addService(pkg.agentluoss.v1.runtime.AgentRuntime.service, impl);
  await new Promise<void>((resolve) => server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), () => resolve()));
  console.log(`[runtime] ${RUNTIME_ID} gRPC on :${PORT}, task=${TASK_ADDR}, max_sessions=${MAX_SESSIONS}`);

  const shutdown = () => {
    console.log("[runtime] shutting down");
    pool.disposeAll();
    server.tryShutdown(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[runtime] fatal:", err);
  process.exit(1);
});
