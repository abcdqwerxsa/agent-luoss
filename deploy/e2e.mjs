// Full-stack e2e verification, run inside the compose network:
//   docker run --rm --network agentluoss_backend -v $PWD:/w -w /w \
//     -e ZAI_API_KEY=<key> -e http_proxy= -e https_proxy= \
//     node:24-bookworm-slim node deploy/e2e.mjs http://gateway:8080
// Prereq: ZAI_API_KEY env (or any openai-compatible key already seeded).
// Optional: `npm install xlsx --no-save` in deploy/ to enable Excel structure assertions
// (excel-master e2e section). When xlsx is not installed, that section degrades to
// file-existence + non-empty checks instead of crashing.
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNAME = `e2e_user_${Date.now().toString(36)}`;
const DEPT = `e2e_dept_${Date.now().toString(36)}`;
const BASE = process.argv[2] || "http://gateway:8080";
const API_KEY = process.env.ZAI_API_KEY || process.env.TEST_API_KEY || "";
const BASE_URL_INPUT = process.env.TEST_BASE_URL || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL_ID = process.env.TEST_MODEL_ID || "glm-5.3-flash";

// Lazy-load the `xlsx` npm package for excel-master assertions; install into a
// throwaway dir if it's not already on the resolution path. Optional — failures
// here only skip the structural Excel checks, not the whole e2e.
let xlsx = null;
async function loadXlsx() {
  try {
    xlsx = await import("xlsx");
    return xlsx;
  } catch { /* not on path */ }
  try {
    const td = mkdtempSync(join(tmpdir(), "e2e-xlsx-"));
    execSync(`npm install --prefix ${td} --silent --no-audit --no-fund xlsx`, { stdio: "pipe" });
    xlsx = await import(join(td, "node_modules", "xlsx", "xlsx.mjs").replace(/\\/g, "/"))
        .catch(() => import(join(td, "node_modules", "xlsx")));
    return xlsx;
  } catch (e) {
    console.warn("WARN: xlsx module unavailable, Excel structure checks will degrade:", e.message);
    return null;
  }
}

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

  // 14. excel-master expert: upload skill, create expert, run MVP scenario,
  //     verify the agent produces a real .xlsx with formulas + charts.
  //     Assertions are STRUCTURAL (no specific numbers) so different LLM outputs
  //     still pass — we only check: skill uploaded, expert saved, member sees
  //     it, task settled, .xlsx file exists in workspace, file is non-empty,
  //     (when xlsx module available) it has formulas + at least 1 chart.
  let excelTask;
  {
    // Build the excel-master skill zip from the repo's skills/excel-master/ tree.
    // Reuses makeZip() (stored, no compression) — same as e2e-skill above.
    const { makeZip } = await import("./zip.mjs");
    const skillFiles = {
      "excel-master/SKILL.md": readUtf8("../../skills/excel-master/SKILL.md"),
      "excel-master/README.md": readUtf8("../../skills/excel-master/README.md"),
      "excel-master/tools/excel_inspect.py": readUtf8("../../skills/excel-master/tools/excel_inspect.py"),
      "excel-master/tools/excel_build.py": readUtf8("../../skills/excel-master/tools/excel_build.py"),
      "excel-master/tools/excel_chart.py": readUtf8("../../skills/excel-master/tools/excel_chart.py"),
      "excel-master/tools/excel_summary.py": readUtf8("../../skills/excel-master/tools/excel_summary.py"),
      "excel-master/sample_data/cross_border_ecom.json": readUtf8("../../skills/excel-master/sample_data/cross_border_ecom.json"),
      "excel-master/sample_data/cross_border_ecom.charts.json": readUtf8("../../skills/excel-master/sample_data/cross_border_ecom.charts.json"),
    };
    const zip = makeZip(skillFiles);
    const fd = new FormData();
    fd.append("file", new Blob([zip]), "excel-master.zip");
    fd.append("id", "excel-master");
    fd.append("scopes", JSON.stringify([{ type: "all", value: "" }]));
    fd.append("enabled", "true");
    const upx = await fetch(`${BASE}/api/v1/admin/skills/upload`, { method: "POST", headers: { Authorization: H.Authorization }, body: fd });
    const upxj = await upx.json();
    ok("excel-master skill uploaded", upx.ok && upxj.skill?.id === "excel-master", JSON.stringify(upxj.skill || upxj).slice(0, 200));

    // Create the expert bundling that skill.
    const pex = await fetch(`${BASE}/api/v1/admin/experts`, { method: "PUT", headers: H, body: JSON.stringify({
      id: "excel-master", name: "Excel 专家", description: "Excel 解析/生成/修改",
      enabled: true, skill_ids: ["excel-master"], mcp_ids: [], scopes: [{ type: "all", value: "" }],
    })});
    ok("excel-master expert saved", pex.ok);

    const mexp2 = await (await fetch(`${BASE}/api/v1/experts`, { headers: { Authorization: `Bearer ${member.access_token}` } })).json();
    ok("excel-master visible to member", (mexp2.experts || []).some((e) => e.id === "excel-master"));

    // Member runs the MVP scenario through the expert.
    const cex = await fetch(`${BASE}/api/v1/tasks`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${member.access_token}` }, body: JSON.stringify({
      title: "跨境电商趋势 Excel", mode: "craft", provider: m.provider_id, model_id: m.model_id,
      first_message: "请根据 excel-master 技能生成一份中国跨境电商交易额与出口占比近 10 年趋势(2015-2025)的 Excel,要求包含年份、交易额、同比增长率(用公式)、出口额、出口占中国出口总额比例(用公式)、数据来源备注 6 列,加双轴折线图与出口额面积图,所有计算字段用公式,任务结束时给 2-3 条关键趋势总结。",
      expert_id: "excel-master",
    })});
    ({ task: excelTask } = await cex.json());
    ok("excel-master task created with expert_id", cex.ok && excelTask?.expert_id === "excel-master", excelTask?.expert_id);

    const evX = await streamUntil(excelTask.id, { Authorization: `Bearer ${member.access_token}`, "Content-Type": "application/json" }, 240_000);
    ok("excel-master task settled", evX.settled, `${evX.toolCalls} tool calls`);
    ok("excel-master task used tools (likely bash+python)", evX.toolCalls > 0);

    // Find the generated .xlsx in the member's workspace.
    const filesX = await (await fetch(`${BASE}/api/v1/files?path=`, { headers: { Authorization: `Bearer ${member.access_token}` } })).json();
    const xlsxNode = (filesX.nodes || []).find((n) => n.name && /\.xlsx?$/i.test(n.name) && !n.is_dir);
    ok("xlsx file in workspace", !!xlsxNode, xlsxNode?.name);

    if (xlsxNode) {
      // Download and verify it's non-empty + has the xlsx magic bytes.
      const dl = await fetch(`${BASE}/api/v1/files/download?path=${encodeURIComponent(xlsxNode.name)}`, { headers: { Authorization: `Bearer ${member.access_token}` } });
      const buf = Buffer.from(await dl.arrayBuffer());
      ok("xlsx download ok + non-empty", dl.ok && buf.length > 1024, `${buf.length} bytes`);
      ok("xlsx is a valid zip (PK magic)", buf[0] === 0x50 && buf[1] === 0x4b, `${buf[0]?.toString(16)} ${buf[1]?.toString(16)}`);

      // Structural checks (only when xlsx module is available).
      const lib = await loadXlsx();
      if (lib && dl.ok) {
        try {
          const wb = lib.read(buf, { cellFormula: true, cellStyles: true });
          const sheetNames = wb.SheetNames || [];
          ok("xlsx re-opens with >=1 sheet", sheetNames.length >= 1, sheetNames.join(","));
          let formulaCount = 0, chartCount = 0;
          for (const name of sheetNames) {
            const ws = wb.Sheets[name];
            for (const addr of Object.keys(ws)) {
                if (addr[0] === "!") continue;
                const cell = ws[addr];
                if (cell && typeof cell.f === "string" && cell.f.startsWith("=")) formulaCount++;
              }
            // openpyxl writes charts into xl/charts/* which the `xlsx` package
            // doesn't expose directly; fall back to zip enumeration below.
          }
          ok("xlsx has formula cells", formulaCount > 0, `${formulaCount} formula cells`);
          // Chart presence: re-open as a zip and look for xl/charts/*.xml.
          // (No extra dep — node has zlib + the file is small.)
          const hasCharts = countChartsInZip(buf);
          ok("xlsx has chart parts", hasCharts > 0, `${hasCharts} chart XML parts`);
        } catch (e) {
          ok("xlsx structure parse", false, e.message);
        }
      } else {
        console.log("  (skipped xlsx formula/chart structural checks: xlsx module unavailable)");
      }
    }
  }

  // 15. cleanup: remove everything this run created (idempotent, best-effort)
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
      if (s.id === "excel-master") await fetch(`${BASE}/api/v1/admin/skills/${s.id}`, { method: "DELETE", headers: H }).catch(() => {});
    }
    await fetch(`${BASE}/api/v1/admin/experts/excel-master`, { method: "DELETE", headers: H }).catch(() => {});
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

// ---- helpers used by excel-master e2e section ----

function readUtf8(rel) {
  // Path is relative to deploy/ (where this script lives), resolved against CWD
  // because the script is invoked from the repo root in standard usage.
  const fs = require("node:fs");
  const path = require("node:path");
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}

// Count xl/charts/*.xml entries in an xlsx (which is a ZIP archive). We do this
// with a tiny built-in ZIP central-directory scan so we don't need a zip library.
function countChartsInZip(buf) {
  // Find EOCD record (0x06054b50) by scanning backwards.
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return 0;
  const total = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  let count = 0;
  for (let i = 0; i < total; i++) {
    if (cdOff + 46 > buf.length) break;
    if (buf.readUInt32LE(cdOff) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const nameStart = cdOff + 46;
    if (nameStart + nameLen > buf.length) break;
    const name = buf.toString("utf8", nameStart, nameStart + nameLen);
    if (name.startsWith("xl/charts/") && name.endsWith(".xml")) count++;
    cdOff = nameStart + nameLen + extraLen + commentLen;
  }
  return count;
}

main().catch((e) => { console.error("E2E CRASH:", e.message); process.exit(1); });
