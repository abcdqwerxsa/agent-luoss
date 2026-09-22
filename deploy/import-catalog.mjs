// Bulk-import curated local experts (skills + MCP servers + expert bundles)
// into a running agent-luoss gateway via the admin REST API.
//
// Usage: node import-catalog.mjs http://127.0.0.1:18090 [admin-user admin-pass]
//
// Skills are vendored under deploy/catalog/skills/<dir> (license policy: see
// deploy/catalog/README.md). MCP stdio binaries must be baked into the runtime
// image (deploy/Dockerfile.runtime) before the experts that use them are used.
import { makeZip } from "./zip.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(HERE, "catalog", "skills");

// Upstream: github.com/anthropics/skills @ 34040c9 (2026-09-10), Apache-2.0
// Upstream: github.com/modelcontextprotocol/servers (npm @modelcontextprotocol/server-*), MIT/Apache-2.0
const CATALOG = {
  skills: [
    { id: "skill-creator", dir: "skill-creator" },
    { id: "mcp-builder", dir: "mcp-builder" },
    { id: "web-artifacts-builder", dir: "web-artifacts-builder" },
    { id: "frontend-design", dir: "frontend-design" },
    { id: "canvas-design", dir: "canvas-design" },
    { id: "theme-factory", dir: "theme-factory" },
    { id: "algorithmic-art", dir: "algorithmic-art" },
    { id: "internal-comms", dir: "internal-comms" },
    { id: "infographic-storyteller", dir: "infographic-storyteller" }, // first-party, Apache-2.0
  ],
  mcps: [
    { id: "official-git", name: "Git", transport: "stdio", command: "mcp-server-git", args: [] },
    { id: "official-memory", name: "Memory", transport: "stdio", command: "mcp-server-memory", args: [],
      env: { MEMORY_FILE_PATH: "/data/workspaces/_shared/team-memory.json" } },
    { id: "official-sequential-thinking", name: "Sequential Thinking", transport: "stdio", command: "mcp-server-sequential-thinking", args: [] },
  ],
  experts: [
    { id: "meta-skill-forge", name: "平台工坊·技能铸造",
      description: "在平台内创建、改进技能与 MCP 服务器（来源 anthropics/skills Apache-2.0 @34040c9）",
      skill_ids: ["skill-creator", "mcp-builder"], mcp_ids: [] },
    { id: "dev-web-builder", name: "开发构建·Web 工匠",
      description: "构建多组件 Web 作品：React/Tailwind/shadcn 组件与前端视觉设计（来源 anthropics/skills Apache-2.0 @34040c9）",
      skill_ids: ["web-artifacts-builder", "frontend-design"], mcp_ids: [] },
    { id: "dev-repo", name: "开发构建·仓库管家",
      description: "Git 仓库操作：状态/差异/日志/分支/提交（MCP 来源 modelcontextprotocol/servers MIT/Apache-2.0）",
      skill_ids: [], mcp_ids: ["official-git"] },
    { id: "design-visual-studio", name: "设计创作·视觉工作室",
      description: "海报/信息图等 PNG/PDF 视觉作品与 p5.js 生成艺术（来源 anthropics/skills Apache-2.0 @34040c9）",
      skill_ids: ["canvas-design", "algorithmic-art"], mcp_ids: [] },
    { id: "design-theme-lab", name: "设计创作·主题实验室",
      description: "为幻灯/文档/报告/落地页套用 10 套预设主题（来源 anthropics/skills Apache-2.0 @34040c9）",
      skill_ids: ["theme-factory"], mcp_ids: [] },
    { id: "office-comms", name: "办公协作·内部沟通",
      description: "企业内部沟通文案：公告/简报/FAQ 等格式化写作（来源 anthropics/skills Apache-2.0 @34040c9）",
      skill_ids: ["internal-comms"], mcp_ids: [] },
    { id: "kb-team-memory", name: "知识记忆·团队大脑",
      description: "跨会话团队共享知识图谱 + 结构化逐步推理（MCP 来源 modelcontextprotocol/servers MIT/Apache-2.0；记忆全员共享）",
      skill_ids: [], mcp_ids: ["official-memory", "official-sequential-thinking"] },
    { id: "data-viz", name: "数据分析·信息图工坊",
      description: "把数据与结构化信息直接渲染成聊天内信息图（AntV Infographic DSL→SVG；平台内置渲染）",
      skill_ids: ["infographic-storyteller"], mcp_ids: [] },
  ],
};

const base = process.argv[2];
const [user, pass] = [process.argv[3] || "admin", process.argv[4] || "admin12345"];
if (!base) { console.error("usage: node import-catalog.mjs <gateway-base> [user pass]"); process.exit(1); }
const ok = (cond, msg, extra) => { if (!cond) { console.error("FAIL:", msg, extra || ""); process.exit(1); } console.log("ok:", msg); };

const login = await (await fetch(`${base}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: user, password: pass }),
})).json();
ok(login.access_token, "admin login");
const H = { Authorization: `Bearer ${login.access_token}` };
const J = { ...H, "Content-Type": "application/json" };

// 1. skills: zip each vendored dir and upload with deterministic id
for (const s of CATALOG.skills) {
  const dir = path.join(SKILLS_DIR, s.dir);
  ok(fs.existsSync(path.join(dir, "SKILL.md")), `skill ${s.id}: SKILL.md present`);
  const files = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else files[`${s.dir}/${r}`] = fs.readFileSync(p);
    }
  };
  walk(dir, "");
  const zip = makeZip(files);
  ok(zip.length <= 10 * 1024 * 1024, `skill ${s.id}: zip ${zip.length} bytes within 10MB`);
  const fd = new FormData();
  fd.append("file", new Blob([zip], { type: "application/zip" }), `${s.id}.zip`);
  fd.append("id", s.id);
  fd.append("enabled", "true");
  const r = await (await fetch(`${base}/api/v1/admin/skills/upload`, { method: "POST", headers: H, body: fd })).json();
  ok(r.skill?.id === s.id, `skill ${s.id} uploaded`, r.error || r.skill?.name);
}

// 2. mcp servers
for (const m of CATALOG.mcps) {
  const r = await fetch(`${base}/api/v1/admin/mcp`, { method: "PUT", headers: J, body: JSON.stringify({ ...m, enabled: true }) });
  ok(r.ok, `mcp ${m.id} upsert`, await r.text());
}

// 3. experts (must come after skills/mcp — expert_items has no FK validation)
for (const e of CATALOG.experts) {
  const r = await fetch(`${base}/api/v1/admin/experts`, {
    method: "PUT", headers: J,
    body: JSON.stringify({ ...e, enabled: true, scopes: [{ type: "all", value: "" }] }),
  });
  ok(r.ok, `expert ${e.id} upsert`, await r.text());
}

// 4. verify
const list = await (await fetch(`${base}/api/v1/experts`, { headers: H })).json();
const have = new Set((list.experts || []).map((e) => e.id));
const missing = CATALOG.experts.map((e) => e.id).filter((id) => !have.has(id));
ok(!missing.length, `all ${CATALOG.experts.length} experts visible`, missing.join(","));
console.log("done.");
