// Smoke: knowledge base end-to-end via gateway REST.
// Usage: node smoke-kb.mjs <gateway-base>
// Asserts: create KB -> upload md -> ingest to ready -> caps MCP entry exists -> cleanup.
const BASE = process.argv[2] || "http://127.0.0.1:18090";
const login = await (await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "admin12345" }),
})).json();
const H = { Authorization: `Bearer ${login.access_token}` };
let failed = 0;
const ok = (name, cond) => { console.log(cond ? `ok: ${name}` : `FAIL: ${name}`); if (!cond) failed = 1; };

// 1. create KB
const cr = await fetch(`${BASE}/api/v1/admin/kb?name=${encodeURIComponent("smoke-知识库-" + Date.now())}&scope_type=all`, { method: "POST", headers: H });
const { kb } = await cr.json();
ok("create kb", cr.status === 200 && kb?.id?.startsWith("kb_"));

// 2. upload a markdown doc
const md = `# 员工手册\n\n## 报销流程\n\n员工出差后需要在7个工作日内提交报销申请，单张发票金额超过5000元需要部门总监审批。\n\n## 会议室预约\n\n会议室通过OA系统预约。`;
const fd = new FormData();
fd.append("file", new File([md], "handbook.md", { type: "text/markdown" }));
const up = await fetch(`${BASE}/api/v1/admin/kb/${kb.id}/docs`, { method: "POST", headers: H, body: fd });
const { doc } = await up.json();
ok("upload doc", up.status === 200 && doc?.id?.startsWith("doc_"));

// 3. wait for ingest -> ready
let ready = false, last = null;
for (let i = 0; i < 30 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const { docs } = await (await fetch(`${BASE}/api/v1/admin/kb/${kb.id}/docs`, { headers: H })).json();
  last = docs?.find((d) => d.id === doc.id);
  ready = last?.status === "ready";
  if (last?.status === "failed") break;
}
ok(`ingest ready (status=${last?.status} err=${last?.error || ""})`, ready);

// 4. caps entry registered with the per-KB MCP url
const { servers } = await (await fetch(`${BASE}/api/v1/admin/mcp`, { headers: H })).json();
const entry = servers?.find((s) => s.id === kb.mcp_entry_id);
ok("caps mcp entry", !!entry && entry.transport === "http" && entry.url.includes(`/mcp/${kb.id}`));

// 5. user-facing visibility (admin sees all-scope)
const mine = await (await fetch(`${BASE}/api/v1/kb`, { headers: H })).json();
ok("list kbs for user", (mine.kbs || []).some((k) => k.id === kb.id));

// 6. cleanup
await fetch(`${BASE}/api/v1/admin/kb/${kb.id}`, { method: "DELETE", headers: H });
const after = await (await fetch(`${BASE}/api/v1/admin/mcp`, { headers: H })).json();
ok("cleanup (kb + caps entry)", !(after.servers || []).some((s) => s.id === kb.mcp_entry_id));

console.log(failed ? "SMOKE-FAIL" : "SMOKE-PASS");
process.exit(failed);
