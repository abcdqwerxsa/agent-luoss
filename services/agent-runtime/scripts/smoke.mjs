// Self-contained smoke test for agent-runtime:
//   1. stub Task service (RegisterRuntime/Heartbeat/PushEvents — prints events)
//   2. spawn agent-runtime with test config
//   3. CreateSession + Prompt + Abort flow against it
// Usage: node scripts/smoke.mjs [workspaceDir]
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const protoDir = path.resolve(root, "../../proto");
const smokeDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "rt-smoke-"));
const mode = process.argv[3] || "craft";

fs.mkdirSync(path.join(smokeDir, "config"), { recursive: true });
fs.mkdirSync(path.join(smokeDir, "sessions"), { recursive: true });
fs.mkdirSync(path.join(smokeDir, "agent"), { recursive: true });
const ws = path.join(smokeDir, "ws", "alice");
fs.mkdirSync(ws, { recursive: true });

// config copies from the host pi config (secrets stay local to smokeDir)
fs.copyFileSync(path.join(os.homedir(), ".pi/agent/auth.json"), path.join(smokeDir, "config/auth.json"));
fs.copyFileSync(path.join(os.homedir(), ".pi/agent/models.json"), path.join(smokeDir, "config/models.json"));
const modelsCfg = JSON.parse(fs.readFileSync(path.join(smokeDir, "config/models.json"), "utf8"));
const provider = Object.keys(modelsCfg.providers)[0];
const modelId = modelsCfg.providers[provider].models[0].id;
console.log(`smoke dir: ${smokeDir}\nprovider/model: ${provider}/${modelId} mode=${mode}`);

const def = protoLoader.loadSync(`${protoDir}/task.proto`, { includeDirs: [protoDir], keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true });
const pkg = grpc.loadPackageDefinition(def);
const runtimeDef = protoLoader.loadSync(`${protoDir}/runtime.proto`, { includeDirs: [protoDir], keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true });
const rpkg = grpc.loadPackageDefinition(runtimeDef);

let settled = false;
let text = "";
const toolCalls = [];

// ---- stub Task service ----
const stub = new grpc.Server();
stub.addService(pkg.agentluoss.v1.task.Task.service, {
  registerRuntime: (call, cb) => { console.log("[stub] registerRuntime:", call.request.runtimeId, call.request.address); cb(null, {}); },
  runtimeHeartbeat: (call, cb) => cb(null, {}),
  pushEvents: (call, cb) => {
    call.on("data", (ev) => {
      if (ev.type === "message_update") {
        const d = JSON.parse(ev.payload).assistantMessageEvent;
        if (d?.type === "text_delta") { text += d.delta; process.stdout.write(d.delta); }
      } else if (ev.type === "tool_execution_start") {
        toolCalls.push(JSON.parse(ev.payload).toolName);
        process.stdout.write(`\n[tool:${toolCalls.at(-1)}]`);
      } else if (ev.type === "agent_settled") {
        settled = true;
      } else if (["agent_start", "message_end", "turn_end", "agent_end"].includes(ev.type)) {
        // progress markers, keep quiet
      } else if (ev.type === "error") {
        console.log("\n[error]", ev.payload);
      }
    });
    call.on("end", () => cb(null, { accepted: 0 }));
  },
});
await new Promise((r) => stub.bindAsync("127.0.0.1:9092", grpc.ServerCredentials.createInsecure(), r));

// ---- spawn runtime ----
const runtime = spawn("node", [path.join(root, "dist/index.js")], {
  env: {
    ...process.env,
    PORT: "9100",
    RUNTIME_ID: "rt-smoke",
    ADVERTISE_ADDR: "127.0.0.1:9100",
    TASK_ADDR: "127.0.0.1:9092",
    MODELS_PATH: path.join(smokeDir, "config/models.json"),
    AUTH_PATH: path.join(smokeDir, "config/auth.json"),
    SESSIONS_DIR: path.join(smokeDir, "sessions"),
    AGENT_DIR: path.join(smokeDir, "agent"),
    MAX_SESSIONS: "10",
    IDLE_TTL_MS: String(60_000),
    PROTO_DIR: protoDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
runtime.stdout.on("data", (b) => console.log("[runtime]", String(b).trim()));
runtime.stderr.on("data", (b) => console.error("[runtime!]", String(b).trim()));

const client = new rpkg.agentluoss.v1.runtime.AgentRuntime("127.0.0.1:9100", grpc.credentials.createInsecure());
const call = (m, req) => new Promise((res, rej) => client[m](req, (err, resp) => (err ? rej(err) : res(resp))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${what}`);
};

try {
  // runtime needs a moment to register + init
  await sleep(1500);
  const hb = await call("heartbeat", {});
  console.log("heartbeat:", JSON.stringify(hb));

  const modeNum = { ask: 1, craft: 2, plan: 3 }[mode];
  const created = await call("createSession", {
    taskId: "t_smoke1", userId: "alice", mode: modeNum,
    model: { provider, modelId: modelId },
    workspacePath: ws, sessionPath: "",
  });
  console.log("\ncreated:", JSON.stringify(created));

  const promptText = mode === "ask"
    ? "用一句话说明当前工作目录里有什么文件（可以查看，不要修改）"
    : "在工作目录创建 hello.txt，内容为 'hi from smoke'，然后列出目录确认";
  console.log(`\nprompt: ${promptText}\n---stream---`);
  await call("prompt", { taskId: "t_smoke1", message: promptText });
  await waitFor(() => settled, 120_000, "agent_settled");
  console.log(`\n---stream end---\ntool calls: ${toolCalls.length} (${toolCalls.join(",")})`);

  if (!fs.existsSync(created.sessionPath)) throw new Error("session file missing after run");

  if (mode !== "ask") {
    const hello = path.join(ws, "hello.txt");
    if (!fs.existsSync(hello)) throw new Error("hello.txt not created");
    console.log("hello.txt content:", fs.readFileSync(hello, "utf8"));
  }

  // resume check: close session, re-create with session_path
  await call("closeSession", { taskId: "t_smoke1" });
  const resumed = await call("createSession", {
    taskId: "t_smoke1", userId: "alice", mode: modeNum,
    model: { provider, modelId: modelId },
    workspacePath: ws, sessionPath: created.sessionPath,
  });
  if (!resumed.resumed) throw new Error("resumed flag not set");
  const state = await call("getSessionState", { taskId: "t_smoke1" });
  console.log("resumed state:", JSON.stringify(state));
  if (state.messageCount < 2) throw new Error("resumed session should have messages");

  console.log("\nSMOKE OK");
} catch (err) {
  console.error('\nSMOKE FAILED:', err);
  process.exitCode = 1;
} finally {
  try { await call("closeSession", { taskId: "t_smoke1" }); } catch {}
  runtime.kill("SIGTERM");
  stub.tryShutdown(() => {});
  await sleep(500);
  process.exit(0);
}
