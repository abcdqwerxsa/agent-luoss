// Smoke: verify imported MCP experts actually work end-to-end.
// Usage: node smoke-experts.mjs <gateway-base>
const BASE = process.argv[2] || "http://127.0.0.1:18090";
const login = await (await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "admin12345" }),
})).json();
const H = { "Content-Type": "application/json", Authorization: `Bearer ${login.access_token}` };
const m = (await (await fetch(`${BASE}/api/v1/models`, { headers: H })).json()).models[0];
console.log("model:", m.provider_id + "/" + m.model_id);

const ct = await fetch(`${BASE}/api/v1/tasks`, { method: "POST", headers: H, body: JSON.stringify({
  title: "smoke kb-team-memory", mode: "craft", provider: m.provider_id, model_id: m.model_id,
  first_message: "用 memory 工具创建两个实体：'AgentLuoss' 和 '本地专家目录'，并建立关系'包含'。然后用工具读回图谱确认，简述结果。",
  expert_id: "kb-team-memory",
})});
const { task } = await ct.json();
console.log("task:", task.id, "expert:", task.expert_id);

const ev = await streamUntil(task.id, H, 240_000);
console.log(`settled=${ev.settled} toolCalls=${ev.toolCalls} (${Date.now() - ev.t0}ms)`);
await fetch(`${BASE}/api/v1/tasks/${task.id}`, { method: "DELETE", headers: H }).catch(() => {});
console.log(ev.settled && ev.toolCalls > 0 ? "SMOKE-PASS" : "SMOKE-FAIL");

async function streamUntil(taskId, H, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/events?access_token=${encodeURIComponent(H.Authorization.slice(7))}`, {
      headers: { Authorization: H.Authorization }, signal: ctl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", settled = false, toolCalls = 0, lastText = "";
    while (!settled) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const ev = JSON.parse(dataLine.slice(6));
        if (ev.type === "tool_execution_start") toolCalls++;
        if (ev.type === "message_delta" && ev.payload?.text) lastText = ev.payload.text;
        if (ev.type === "agent_settled") { settled = true; break; }
        if (ev.type === "error") throw new Error("error event: " + JSON.stringify(ev.payload).slice(0, 300));
      }
    }
    if (lastText) console.log("assistant tail:", lastText.slice(-200).replace(/\n/g, " "));
    return { settled, toolCalls, t0 };
  } finally { clearTimeout(timer); }
}
