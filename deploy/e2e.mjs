// Full-stack e2e verification, run inside the compose network:
//   docker run --rm --network agentluoss_backend -v $PWD:/w -w /w \
//     node:24-bookworm-slim node deploy/e2e.mjs http://gateway:8080
// Prereq: ZAI_API_KEY env (or any openai-compatible key already seeded).
const UNAME = `e2e_user_${Date.now().toString(36)}`;
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
