// Full-stack e2e verification, run inside the compose network:
//   docker run --rm --network agentluoss_backend -v $PWD:/w -w /w \
//     node:24-bookworm-slim node deploy/e2e.mjs http://gateway:8080
// Prereq: ZAI_API_KEY env (or any openai-compatible key already seeded).
const UNAME = `e2e_user_${Date.now().toString(36)}`;
const DEPT = `e2e_dept_${Date.now().toString(36)}`;
const BASE = process.argv[2] || "http://gateway:8080";
const API_KEY = process.env.ZAI_API_KEY || process.env.TEST_API_KEY || "";
const BASE_URL_INPUT = process.env.TEST_BASE_URL || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL_ID = process.env.TEST_MODEL_ID || "glm-5.3-flash";

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

async function main() {
  // 1. health
  const h = await fetch(`${BASE}/healthz`);
  ok("gateway healthz", h.ok);

  // 2. login (admin bootstrapped by iam env)
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "admin12345" }),
  });
  const auth = await login.json();
  ok("admin login", login.ok && !!auth.access_token);
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${auth.access_token}` };

  // 3. seed provider+model (skip if key missing and provider already exists)
  const models0 = await (await fetch(`${BASE}/api/v1/models`, { headers: H })).json();
  if (API_KEY && (!models0.models || models0.models.length === 0)) {
    await fetch(`${BASE}/api/v1/admin/providers`, { method: "PUT", headers: H, body: JSON.stringify({
      id: "zai", name: "Zhipu", base_url: BASE_URL_INPUT, api_type: "openai-completions", api_key: API_KEY, enabled: true,
    })});
    await fetch(`${BASE}/api/v1/admin/models`, { method: "PUT", headers: H, body: JSON.stringify({
      provider_id: "zai", model_id: MODEL_ID, display_name: "Test Model", context_window: 128000, enabled: true,
    })});
    // small delay for render + runtime reload
    await sleep(3000);
  }
  const models = await (await fetch(`${BASE}/api/v1/models`, { headers: H })).json();
  ok("model available", models.models?.length > 0, `${models.models?.length || 0} models`);
  const m = models.models[0];

  // 4. create task with first message (plan mode → confirmation flow)
  const ct = await fetch(`${BASE}/api/v1/tasks`, { method: "POST", headers: H, body: JSON.stringify({
    title: "e2e", mode: "plan", provider: m.provider_id, model_id: m.model_id,
    first_message: "请创建 report.txt 内容为 e2e-ok，然后结束",
  })});
  const { task } = await ct.json();
  ok("task created", ct.ok, task.id);

  // 5. SSE until settled; plan mode then needs an explicit confirmation round
  const t0 = Date.now();
  let ev = await streamUntil(task.id, H, 180_000);
  if (ev.settled && ev.toolCalls === 0) {
    await fetch(`${BASE}/api/v1/tasks/${task.id}/messages`, {
      method: "POST", headers: H, body: JSON.stringify({ message: "确认执行" }),
    });
    ev = await streamUntil(task.id, H, 180_000);
  }
  ok("task settled", ev.settled, `${ev.toolCalls} tool calls, ${Date.now() - t0}ms`);

  // 6. artifact: file created + download
  const files = await (await fetch(`${BASE}/api/v1/files?path=`, { headers: H })).json();
  const rpt = (files.nodes || []).find((n) => n.name === "report.txt");
  ok("artifact listed", !!rpt);
  if (rpt) {
    const dl = await fetch(`${BASE}/api/v1/files/download?path=report.txt`, { headers: H });
    ok("artifact download", dl.ok && (await dl.text()).includes("e2e-ok"));
  }

  // 7. history
  const hist = await (await fetch(`${BASE}/api/v1/tasks/${task.id}/messages`, { headers: H })).json();
  ok("history non-empty", hist.messages?.length >= 2, `${hist.messages?.length || 0} messages`);

  // 8. usage recorded
  await sleep(4000);
  const usage = await (await fetch(`${BASE}/api/v1/usage/me`, { headers: H })).json();
  ok("usage recorded", usage.month_used_usd >= 0 && (usage.recent_days?.length || 0) > 0,
     `tokens=${usage.recent_days?.[0]?.total_tokens ?? "?"}`);

  // 9. audit
  const audit = await (await fetch(`${BASE}/api/v1/admin/audit?limit=5`, { headers: H })).json();
  ok("audit captured", (audit.logs?.length || 0) > 0, `total=${audit.total}`);

  // 10. RBAC: member cannot touch admin APIs
  const cu = await fetch(`${BASE}/api/v1/users`, { method: "POST", headers: H, body: JSON.stringify({
    username: UNAME, password: "e2e_password1", display_name: "E2E", role: "member",
  })});
  ok("member created", cu.ok);
  const ml = await fetch(`${BASE}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: UNAME, password: "e2e_password1" })});
  const member = await ml.json();
  const mforbidden = await fetch(`${BASE}/api/v1/users`, { headers: { Authorization: `Bearer ${member.access_token}` } });
  ok("member blocked from admin", mforbidden.status === 403);
  const foreign = await fetch(`${BASE}/api/v1/tasks/${task.id}/messages`, { headers: { Authorization: `Bearer ${member.access_token}` } });
  ok("member blocked from foreign task", foreign.status >= 400 && foreign.status !== 404 ? true : foreign.status === 403);

  // 11. abort flow on a fresh task
  const ct2 = await fetch(`${BASE}/api/v1/tasks`, { method: "POST", headers: H, body: JSON.stringify({
    title: "abort test", mode: "craft", provider: m.provider_id, model_id: m.model_id,
    first_message: "请持续输出数字，不要停止",
  })});
  const { task: task2 } = await ct2.json();
  await sleep(8000);
  const ab = await fetch(`${BASE}/api/v1/tasks/${task2.id}/abort`, { method: "POST", headers: H });
  ok("abort accepted", ab.ok);
  await sleep(2000);
  const g2 = await (await fetch(`${BASE}/api/v1/tasks/${task2.id}`, { headers: H })).json();
  ok("task idle after abort", g2.task.status === "idle", g2.task.status);

  // 12. usage dimensions: by_model / top_users / task usage / CSV export
  const sum = await (await fetch(`${BASE}/api/v1/admin/usage?days=7`, { headers: H })).json();
  ok("usage by_model", Array.isArray(sum.by_model) && sum.by_model.length > 0,
     sum.by_model?.map((x) => `${x.provider}/${x.model_id}`).join(","));
  ok("usage top_users", Array.isArray(sum.top_users) && sum.top_users.length > 0);
  const tu = await (await fetch(`${BASE}/api/v1/tasks/${task.id}/usage`, { headers: H })).json();
  ok("task usage endpoint", tu.total_tokens > 0, `tokens=${tu.total_tokens} cost=${tu.cost_usd}`);
  const csv = await fetch(`${BASE}/api/v1/admin/usage/export?days=7`, { headers: H });
  const csvText = await csv.text();
  ok("usage CSV export", csv.ok && csvText.includes("day,user_id") && csvText.includes("provider,model_id"));

  // 13. caps: departments + scoped MCP/skill injection
  const cd = await fetch(`${BASE}/api/v1/admin/departments`, { method: "POST", headers: H, body: JSON.stringify({ id: DEPT, name: "E2E 部门" })});
  ok("department created", cd.ok);
  const deptExists = await (await fetch(`${BASE}/api/v1/admin/departments`, { headers: H })).json();
  ok("department listed", (deptExists.departments || []).some((d) => d.id === DEPT));

  // member joins the department (used for scope assertions below)
  const users1 = await (await fetch(`${BASE}/api/v1/users`, { headers: H })).json();
  const memberUser = (users1.users || []).find((u) => u.username === UNAME);
  const pd = await fetch(`${BASE}/api/v1/users/${memberUser.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ department_id: DEPT })});
  ok("member assigned department", pd.ok, JSON.stringify((await pd.json()).user?.department_id));

  // upload a platform skill scoped to the department
  const { makeZip } = await import("./zip.mjs");
  const skillZip = makeZip({ "e2e-skill/SKILL.md": "---\nname: e2e-skill\ndescription: When asked to greet, include the marker E2E-SKILL-LOADED.\n---\n# greet\n" });
  const sfd = new FormData();
  sfd.append("file", new Blob([skillZip]), "skill.zip");
  sfd.append("scopes", JSON.stringify([{ type: "department", value: DEPT }]));
  const up = await fetch(`${BASE}/api/v1/admin/skills/upload`, { method: "POST", headers: { Authorization: H.Authorization }, body: sfd });
  const upj = await up.json();
  ok("skill uploaded", up.ok && upj.skill?.name === "e2e-skill", JSON.stringify(upj.skill || upj));

  // stdio echo MCP server (inline node script) scoped to the department
  const echoScript = [
    'const rl=require("readline").createInterface({input:process.stdin});',
    'const send=o=>process.stdout.write(JSON.stringify(o)+"\\n");',
    'rl.on("line",l=>{if(!l.trim())return;const m=JSON.parse(l);',
    'if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"echo",version:"1"}}});',
    'else if(m.method==="tools/list")send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"echo",description:"Echo text back",inputSchema:{type:"object",properties:{text:{type:"string"}},required:["text"]}}]}});',
    'else if(m.method==="tools/call")send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"echo: "+(m.params.arguments?.text||"")}]}});',
    'else if(m.id!==undefined)send({jsonrpc:"2.0",id:m.id,result:{}});});',
  ].join("");
  const pm = await fetch(`${BASE}/api/v1/admin/mcp`, { method: "PUT", headers: H, body: JSON.stringify({
    id: "e2e-echo", name: "echo", transport: "stdio",
    command: "node", args: ["-e", echoScript], env: { E2E_SECRET: "super-secret" },
    enabled: true, scopes: [{ type: "department", value: DEPT }],
  })});
  ok("mcp server saved", pm.ok);
  const mcps = await (await fetch(`${BASE}/api/v1/admin/mcp`, { headers: H })).json();
  const savedMcp = (mcps.servers || []).find((s) => s.id === "e2e-echo");
  ok("mcp listed, env masked", !!savedMcp && savedMcp.env?.E2E_SECRET === "", JSON.stringify(savedMcp?.env));

  // member (in e2e-dept) runs a task that must reach the echo MCP tool
  let task3; let task4;
  const cm = await fetch(`${BASE}/api/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${member.access_token}` }, body: JSON.stringify({
    title: "mcp test", mode: "craft", provider: m.provider_id, model_id: m.model_id,
    first_message: "调用 MCP 服务器 echo 的 echo 工具，text 参数为 e2e-mcp。把返回原样告诉我。",
  })});
  ({ task: task3 } = await cm.json());
  ok("member task created", cm.ok, task3.id);
  const ev3 = await streamUntil(task3.id, { Authorization: `Bearer ${member.access_token}`, "Content-Type": "application/json" }, 180_000);
  ok("member task settled", ev3.settled, `${ev3.toolCalls} tool calls`);
  const hist3 = await (await fetch(`${BASE}/api/v1/tasks/${task3.id}/messages`, { headers: { Authorization: `Bearer ${member.access_token}` } })).json();
  const last3 = hist3.messages?.at(-1);
  const txt3 = typeof last3?.content === "string" ? last3.content : JSON.stringify(last3?.content);
  ok("mcp tool called by member", ev3.toolCalls > 0);
  ok("mcp echo result in reply", /echo:\s*e2e-mcp/.test(txt3), txt3?.slice(0, 200));

  // member blocked from caps admin
  const mforbidden2 = await fetch(`${BASE}/api/v1/admin/mcp`, { headers: { Authorization: `Bearer ${member.access_token}` } });
  ok("member blocked from caps admin", mforbidden2.status === 403);

  // 13b. experts: bundle echo mcp into an expert, member task uses it
  const pe = await fetch(`${BASE}/api/v1/admin/experts`, { method: "PUT", headers: H, body: JSON.stringify({
    id: "e2e-expert", name: "E2E Expert", description: "echo via expert",
    enabled: true, skill_ids: [], mcp_ids: ["e2e-echo"], scopes: [{ type: "all", value: "" }],
  })});
  ok("expert saved", pe.ok);
  const elist = await (await fetch(`${BASE}/api/v1/experts`, { headers: H })).json();
  ok("expert listed (admin user)", (elist.experts || []).some((e) => e.id === "e2e-expert"));
  const mexp = await (await fetch(`${BASE}/api/v1/experts`, { headers: { Authorization: `Bearer ${member.access_token}` } })).json();
  ok("expert visible to member", (mexp.experts || []).some((e) => e.id === "e2e-expert"));
  const cet = await fetch(`${BASE}/api/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${member.access_token}` }, body: JSON.stringify({
    title: "expert test", mode: "craft", provider: m.provider_id, model_id: m.model_id,
    first_message: "调用 MCP echo 服务器的 echo 工具，text 为 e2e-expert。原样返回结果。",
    expert_id: "e2e-expert",
  })});
  ({ task: task4 } = await cet.json());
  ok("expert task created with expert_id", cet.ok && task4?.expert_id === "e2e-expert", task4?.expert_id);
  const ev4 = await streamUntil(task4.id, { Authorization: `Bearer ${member.access_token}`, "Content-Type": "application/json" }, 180_000);
  ok("expert task settled", ev4.settled, `${ev4.toolCalls} tool calls`);
  ok("expert mcp injected (mcp tool called)", ev4.toolCalls > 0);

  // 14. cleanup: remove everything this run created (idempotent, best-effort)
  const cleanup = async () => {
    const mh = { "Content-Type": "application/json", Authorization: `Bearer ${member.access_token}` };
    for (const t of [task4?.id, task3?.id, task2?.id, task?.id].filter(Boolean)) {
      await fetch(`${BASE}/api/v1/tasks/${t}`, { method: "DELETE", headers: mh }).catch(() => {});
    }
    await fetch(`${BASE}/api/v1/users/${memberUser?.id ?? ""}`, { method: "DELETE", headers: H }).catch(() => {});
    await fetch(`${BASE}/api/v1/admin/departments/${DEPT}`, { method: "DELETE", headers: H }).catch(() => {});
    await fetch(`${BASE}/api/v1/admin/experts/e2e-expert`, { method: "DELETE", headers: H }).catch(() => {});
    await fetch(`${BASE}/api/v1/admin/mcp/e2e-echo`, { method: "DELETE", headers: H }).catch(() => {});
    const sk = await (await fetch(`${BASE}/api/v1/admin/skills`, { headers: H })).json().catch(() => ({}));
    for (const s of sk.skills || []) {
      if (s.name === "e2e-skill") await fetch(`${BASE}/api/v1/admin/skills/${s.id}`, { method: "DELETE", headers: H }).catch(() => {});
    }
  };
  await cleanup();

  console.log(failures === 0 ? "\nE2E ALL PASS" : `\nE2E FAILED: ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function streamUntil(taskId, H, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/v1/tasks/${taskId}/events?access_token=${encodeURIComponent(H.Authorization.slice(7))}`, {
      headers: { Authorization: H.Authorization }, signal: ctl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", settled = false, toolCalls = 0;
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
        if (ev.type === "agent_settled") { settled = true; break; }
        if (ev.type === "error") throw new Error("error event: " + ev.payload);
      }
    }
    return { settled, toolCalls };
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error("E2E CRASH:", e.message); process.exit(1); });
