// Self-contained smoke test for platform caps injection:
//   1. stub Task service (prints events)
//   2. minimal stdio echo MCP server (hand-rolled JSON-RPC)
//   3. spawn agent-runtime, CreateSession with mcpServers + skills
//   4. prompt the agent to call the echo tool, assert the `mcp` proxy tool ran
// Usage: node scripts/smoke-caps.mjs
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const protoDir = path.resolve(root, "../../proto");
const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-caps-"));

fs.mkdirSync(path.join(smokeDir, "config"), { recursive: true });
fs.mkdirSync(path.join(smokeDir, "sessions"), { recursive: true });
fs.mkdirSync(path.join(smokeDir, "agent"), { recursive: true });
const ws = path.join(smokeDir, "ws", "alice");
fs.mkdirSync(ws, { recursive: true });

// ---- echo MCP server (stdio, newline-delimited JSON-RPC) ----
const echoServer = path.join(smokeDir, "echo-mcp.mjs");
fs.writeFileSync(echoServer, `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "echo", version: "1.0" },
    }});
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{
      name: "echo", description: "Echo the given text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }] }});
  } else if (m.method === "tools/call") {
    send({ jsonrpc: "2.0", id: m.id, result: {
      content: [{ type: "text", text: "echo: " + (m.params.arguments?.text ?? "") }],
    }});
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`);

// ---- platform skill ----
const skillDir = path.join(smokeDir, "skills", "s_greet");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, "SKILL.md"),
  `---\nname: greet-helper\ndescription: When asked to greet, reply with exactly CAPS-SKILL-LOADED as the greeting text.\n---\n`);

// ---- runtime config from host pi ----
fs.copyFileSync(path.join(os.homedir(), ".pi/agent/auth.json"), path.join(smokeDir, "config/auth.json"));
fs.copyFileSync(path.join(os.homedir(), ".pi/agent/models.json"), path.join(smokeDir, "config/models.json"));
const modelsCfg = JSON.parse(fs.readFileSync(path.join(smokeDir, "config/models.json"), "utf8"));
const provider = Object.keys(modelsCfg.providers)[0];
const modelId = modelsCfg.providers[provider].models[0].id;
console.log(`smoke dir: ${smokeDir}\nprovider/model: ${provider}/${modelId}`);

const def = protoLoader.loadSync(`${protoDir}/task.proto`, { includeDirs: [protoDir], keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true });
const pkg = grpc.loadPackageDefinition(def);
const runtimeDef = protoLoader.loadSync(`${protoDir}/runtime.proto`, { includeDirs: [protoDir], keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true });
const rpkg = grpc.loadPackageDefinition(runtimeDef);

let settled = false;
let text = "";
const toolCalls = [];
const stub = new grpc.Server();
stub.addService(pkg.agentluoss.v1.task.Task.service, {
  registerRuntime: (call, cb) => cb(null, {}),
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
      } else if (ev.type === "error") {
        console.log("\n[error]", ev.payload);
      }
    });
    call.on("end", () => cb(null, { accepted: 0 }));
  },
});
await new Promise((r) => stub.bindAsync("127.0.0.1:9192", grpc.ServerCredentials.createInsecure(), r));

const runtime = spawn("node", [path.join(root, "dist/index.js")], {
  env: {
    ...process.env,
    PORT: "9110", RUNTIME_ID: "rt-caps", ADVERTISE_ADDR: "127.0.0.1:9110", TASK_ADDR: "127.0.0.1:9192",
    MODELS_PATH: path.join(smokeDir, "config/models.json"),
    AUTH_PATH: path.join(smokeDir, "config/auth.json"),
    SESSIONS_DIR: path.join(smokeDir, "sessions"),
    AGENT_DIR: path.join(smokeDir, "agent"),
    MAX_SESSIONS: "10", IDLE_TTL_MS: String(60_000), PROTO_DIR: protoDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
runtime.stdout.on("data", (b) => console.log("[runtime]", String(b).trim()));
runtime.stderr.on("data", (b) => console.error("[runtime!]", String(b).trim()));

const client = new rpkg.agentluoss.v1.runtime.AgentRuntime("127.0.0.1:9110", grpc.credentials.createInsecure());
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
  await sleep(1500);
  const created = await call("createSession", {
    taskId: "t_caps1", userId: "alice", mode: 2, // craft
    model: { provider, modelId },
    workspacePath: ws, sessionPath: "",
    mcpServers: [{
      id: "echo", name: "echo", transport: "stdio",
      command: "node", args: [echoServer], env: {},
    }],
    skills: [{ name: "greet-helper", description: "greeting helper", path: skillDir }],
  });
  console.log("\ncreated:", JSON.stringify(created));

  const promptText = "调用 MCP 服务器 echo 里的 echo 工具，参数 text 为 hello-caps。把工具返回原样告诉我。";
  console.log(`\nprompt: ${promptText}\n---stream---`);
  await call("prompt", { taskId: "t_caps1", message: promptText });
  await waitFor(() => settled, 120_000, "agent_settled");
  console.log(`\n---stream end---\ntool calls: ${toolCalls.length} (${toolCalls.join(",")})`);

  if (!toolCalls.includes("mcp")) throw new Error("mcp proxy tool was not called");
  if (!/echo:\s*hello-caps/.test(text)) throw new Error("echo result missing in assistant text");
  console.log("\nSMOKE-CAPS OK");
} catch (err) {
  console.error("\nSMOKE-CAPS FAILED:", err);
  process.exitCode = 1;
} finally {
  runtime.kill();
  stub.tryShutdown(() => {});
  await sleep(300);
}
