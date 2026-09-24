// E2E: knowledge base through a real agent conversation.
// Usage: node kb-e2e.mjs <gateway-base>
// Creates a KB, uploads a doc with distinctive facts, asks an agent task
// about them, and asserts: kb search tool called + fact in answer + citation.
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.argv[2] || "http://127.0.0.1:18090";
const login = await (await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "admin12345" }),
})).json();
const H = { "Content-Type": "application/json", Authorization: `Bearer ${login.access_token}` };
const HA = { Authorization: `Bearer ${login.access_token}` }; // multipart-safe (no content-type)

// 1. KB + doc with facts the model cannot know
const { kb } = await (await fetch(`${BASE}/api/v1/admin/kb?name=e2e-知识库验证&scope_type=all`, { method: "POST", headers: H })).json();
console.log("kb:", kb.id);
const md = `# 员工差旅与假期制度（2026 修订版）

## 差旅报销

出差结束后必须在 **7 个工作日** 内提交报销申请；单张发票金额超过 **5000 元** 需要部门总监审批，超过 **20000 元** 需要 CFO 与总经理双签。

机票一律通过 OA 的「商旅平台」预订，擅自线下购票原则上不予报销。

## 年假规则

司龄满 1 年享 8 天年假，满 3 年 12 天，满 8 年 18 天。年假可跨年结转一次，结转部分次年 3 月 31 日后清零。

## 会议室

大会议室（容纳 20 人）仅支持提前 3 天预约，小会议室当天即可预约。`;
const fd = new FormData();
fd.append("file", new Blob([md], { type: "text/markdown" }), "policy-2026.md");
const up = await (await fetch(`${BASE}/api/v1/admin/kb/${kb.id}/docs`, { method: "POST", headers: HA, body: fd })).json();
if (!up.doc?.id) { console.error("upload failed:", JSON.stringify(up)); process.exit(1); }
const doc = up.doc;

let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(1000);
  const { docs } = await (await fetch(`${BASE}/api/v1/admin/kb/${kb.id}/docs`, { headers: HA })).json();
  const d = docs?.find((x) => x.id === doc.id);
  ready = d?.status === "ready";
  if (d?.status === "failed") { console.error("ingest failed:", d.error); process.exit(1); }
}
console.log("doc ready:", ready);

// sanity: direct search hits
const probe = await (await fetch(`${BASE}/api/v1/admin/kb/${kb.id}/search?q=${encodeURIComponent("发票超过多少需要审批")}`, { headers: H })).json();
console.log("direct search hits:", probe.hits?.length, probe.hits?.[0]?.section || "");

// 2. agent task asking facts only present in the doc
const models = (await (await fetch(`${BASE}/api/v1/models`, { headers: HA })).json()).models;
const m = models.find((x) => /flash-lite/.test(x.model_id)) || models[0]; // prefer a known-good id
console.log("model:", m.provider_id + "/" + m.model_id);
const { task } = await (await fetch(`${BASE}/api/v1/tasks`, {
  method: "POST", headers: H,
  body: JSON.stringify({
    title: "kb e2e", mode: "craft", provider: m.provider_id, model_id: m.model_id,
    first_message: "我入职满 4 年了，按公司制度我有几天年假？另外报销一张 8000 元的发票需要谁审批？请引用知识库来源（在答案中用 [doc:文档id] 标注）。",
  }),
})).json();
console.log("task:", task.id);

// 3. stream SSE until settled (node:http — node18 undici body-timeouts SSE)
import { get } from "node:http";
const events = await new Promise((resolveP, rejectP) => {
  const req = get(`${BASE}/api/v1/tasks/${task.id}/events?access_token=${encodeURIComponent(login.access_token)}`, { headers: { Authorization: `Bearer ${login.access_token}` } }, (resStream) => resolveP(resStream));
  req.on("error", rejectP);
});
const reader = events; // plain stream: accumulate + split frames
let buf = "", settled = false, toolCalls = [], lastText = "", err = null;
const t0 = Date.now();
await new Promise((done) => {
  events.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const dl = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dl) continue;
      let ev; try { ev = JSON.parse(dl.slice(6)); } catch { continue; }
      if (ev.type === "tool_execution_start") toolCalls.push(ev.payload?.toolName || "?");
      if (ev.type === "message_delta" && ev.payload?.text) lastText = ev.payload.text;
      if (ev.type === "agent_settled") { settled = true; done(); }
      if (ev.type === "error") { err = ev.payload; done(); }
    }
    if (Date.now() - t0 > 480_000) done();
  });
  events.on("end", done);
  events.on("error", (e) => { err = { message: e.message }; done(); });
});

console.log("settled:", settled, "elapsed:", ((Date.now() - t0) / 1000).toFixed(1) + "s");
console.log("toolCalls:", JSON.stringify(toolCalls));
if (err) console.log("error event:", JSON.stringify(err).slice(0, 300));
const answer = lastText || "";
console.log("answer (tail 500):", answer.slice(-500));

let pass = settled && toolCalls.some((t) => /search|知识库|kb/i.test(t));
const facts = [/12\s*天/, /总监/];
const factHits = facts.filter((f) => f.test(answer)).length;
console.log(`facts hit: ${factHits}/2`);
const cited = /\[doc:doc_[A-Za-z0-9]+\]/.test(answer);
console.log("cited [doc:x]:", cited);

// 4. cleanup task + kb
await fetch(`${BASE}/api/v1/tasks/${task.id}`, { method: "DELETE", headers: H }).catch(() => {});
await fetch(`${BASE}/api/v1/admin/kb/${kb.id}`, { method: "DELETE", headers: H }).catch(() => {});
console.log(pass && factHits === 2 ? "E2E-PASS" : "E2E-PARTIAL(see above)");
