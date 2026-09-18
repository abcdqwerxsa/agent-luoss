// E2E smoke for task-svc orchestration + agent-runtime resilience:
//   create task with first_message → stream events → settled →
//   kill runtime → start replacement → prompt again (session resume).
// Prereq: task-svc on :9092, runtime on :9100 (started by this script).
// Usage: node scripts/smoke-task.mjs
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const protoDir = path.resolve(root, "../../proto");
const dir = process.env.SMOKE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
const wsRoot = process.env.WORKSPACES_DIR || "/tmp/e2e-ws"; // must match task-svc WORKSPACES_DIR
for (const p of ["config", "sessions", "agent"]) fs.mkdirSync(path.join(dir, p), { recursive: true });
fs.copyFileSync(path.join(os.homedir(), ".pi/agent/auth.json"), path.join(dir, "config/auth.json"));
fs.copyFileSync(path.join(os.homedir(), ".pi/agent/models.json"), path.join(dir, "config/models.json"));
const modelsCfg = JSON.parse(fs.readFileSync(path.join(dir, "config/models.json"), "utf8"));
const provider = Object.keys(modelsCfg.providers)[0];
const modelId = modelsCfg.providers[provider].models[0].id;

const defs = {
  task: protoLoader.loadSync(`${protoDir}/task.proto`, { includeDirs: [protoDir], keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true }),
  runtime: protoLoader.loadSync(`${protoDir}/runtime.proto`, { includeDirs: [protoDir], keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true }),
};
const tpkg = grpc.loadPackageDefinition(defs.task);
const task = new tpkg.agentluoss.v1.task.Task("127.0.0.1:9092", grpc.credentials.createInsecure());

const runtimeEnv = (id) => ({
  ...process.env,
  PORT: "9100", RUNTIME_ID: id, ADVERTISE_ADDR: "127.0.0.1:9100",
  TASK_ADDR: "127.0.0.1:9092",
  MODELS_PATH: path.join(dir, "config/models.json"),
  AUTH_PATH: path.join(dir, "config/auth.json"),
  SESSIONS_DIR: path.join(dir, "sessions"),
  AGENT_DIR: path.join(dir, "agent"),
  MAX_SESSIONS: "50", IDLE_TTL_MS: "60000", PROTO_DIR: protoDir,
});
const spawnRuntime = (id) => {
  const p = spawn("node", [path.join(root, "dist/index.js")], { env: runtimeEnv(id), stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (b) => console.log(`[${id}]`, String(b).trim()));
  p.stderr.on("data", (b) => console.error(`[${id}!]`, String(b).trim()));
  return p;
};

const md = { "x-user-id": "u_alice", "x-user-role": "member" };
const call = (m, req) => new Promise((res, rej) => task[m](req, md, (err, resp) => (err ? rej(err) : res(resp))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function streamEvents(taskId, onEvent) {
  const s = task.streamEvents({ taskId, userId: "u_alice", sinceSeq: 0 }, md);
  s.on("data", onEvent);
  s.on("error", (e) => console.warn("[stream err]", e.message));
  return s;
}

const runtimeA = spawnRuntime("rt-a");
await sleep(1500);

let taskInfo, textA = "", textB = "";
try {
  // 1. create with first message
  taskInfo = (await call("createTask", {
    userId: "u_alice", title: "", mode: 2,
    model: { provider, modelId },
    firstMessage: "在工作目录创建 step1.txt 内容为 'one'，完成后用一句话确认",
  })).task;
  console.log("created task:", taskInfo.id, "runtime:", taskInfo.runtimeId || "(assign-on-prompt)");

  // 2. stream until settled
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting settled (run 1)")), 120_000);
    const s = streamEvents(taskInfo.id, (ev) => {
      if (ev.type === "message_update") {
        const d = JSON.parse(ev.payload).assistantMessageEvent;
        if (d?.type === "text_delta") { textA += d.delta; }
      } else if (ev.type === "agent_settled") {
        clearTimeout(timer); s.cancel(); resolve();
      } else if (ev.type === "error") {
        clearTimeout(timer); s.cancel(); reject(new Error("error event: " + ev.payload));
      }
    });
  });
  console.log("run1 text:", textA.slice(0, 80));
  const step1 = path.join(wsRoot, "u_alice/step1.txt");
  if (!fs.existsSync(step1)) throw new Error("step1.txt missing");
  console.log("step1.txt:", fs.readFileSync(step1, "utf8"));

  // 3. runtime down, replacement up
  console.log("killing rt-a, starting rt-b...");
  runtimeA.kill("SIGKILL");
  await sleep(500);
  const runtimeB = spawnRuntime("rt-b");
  await sleep(1500);

  // 4. prompt again — task-svc should resume session via rt-b
  await call("sendPrompt", { taskId: taskInfo.id, userId: "u_alice", message: "再创建 step2.txt 内容为 'two'，完成后确认两个文件都在" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting settled (run 2)")), 120_000);
    const s = streamEvents(taskInfo.id, (ev) => {
      if (ev.type === "message_update") {
        const d = JSON.parse(ev.payload).assistantMessageEvent;
        if (d?.type === "text_delta") { textB += d.delta; }
      } else if (ev.type === "agent_settled") {
        clearTimeout(timer); s.cancel(); resolve();
      } else if (ev.type === "error") {
        clearTimeout(timer); s.cancel(); reject(new Error("error event: " + ev.payload));
      }
    });
  });
  console.log("run2 text:", textB.slice(0, 80));
  const step2 = path.join(wsRoot, "u_alice/step2.txt");
  if (!fs.existsSync(step2)) throw new Error("step2.txt missing (resume failed?)");
  console.log("step2.txt:", fs.readFileSync(step2, "utf8"));

  // 5. history + list
  const msgs = JSON.parse((await call("getMessages", { taskId: taskInfo.id, userId: "u_alice" })).messagesJson);
  console.log("history message_end count:", msgs.length);
  if (msgs.length < 4) throw new Error("history too short");

  const listed = await call("listTasks", { userId: "u_alice" });
  console.log("list tasks:", listed.tasks.map((t) => `${t.id}:${t.status}`).join(" "));

  // 6. ownership check
  const foreign = new tpkg.agentluoss.v1.task.Task("127.0.0.1:9092", grpc.credentials.createInsecure());
  await new Promise((res) => foreign.getMessages({ taskId: taskInfo.id, userId: "u_bob" }, { "x-user-id": "u_bob", "x-user-role": "member" }, (err) => {
    if (err?.details !== "not your task") throw new Error("ownership check failed: " + err?.details);
    console.log("ownership check ok");
    res();
  }));

  console.log("\nE2E SMOKE OK");
  process.exitCode = 0;
} catch (err) {
  console.error("\nE2E SMOKE FAILED:", err.message || err);
  process.exitCode = 1;
} finally {
  try { if (taskInfo?.id) await call("deleteTask", { taskId: taskInfo.id }); } catch {}
  runtimeA.kill("SIGTERM");
  await sleep(300);
  process.exit(process.exitCode ?? 0);
}
