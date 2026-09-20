// Remove e2e leftovers from a running stack (idempotent).
// Usage: node deploy/e2e-cleanup.mjs [http://gateway:8080]
const BASE = process.argv[2] || "http://gateway:8080";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin12345";

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
});
const auth = await login.json();
if (!auth.access_token) throw new Error("login failed: " + JSON.stringify(auth));
const H = { "Content-Type": "application/json", Authorization: `Bearer ${auth.access_token}` };
const del = (p) => fetch(`${BASE}${p}`, { method: "DELETE", headers: H }).then((r) => r.status).catch(() => "?");

// tasks created by e2e (title match)
const { tasks } = await (await fetch(`${BASE}/api/v1/tasks?limit=100`, { headers: H })).json();
let n = 0;
for (const t of tasks || []) {
  if (["e2e", "abort test", "mcp test"].includes(t.title)) {
    const st = await del(`/api/v1/tasks/${t.id}`);
    console.log(`task ${t.id} (${t.title}) -> ${st}`); n++;
  }
}

// e2e users (cascade: usage rows keep user_id but rows are history, fine)
const { users } = await (await fetch(`${BASE}/api/v1/users`, { headers: H })).json();
for (const u of users || []) {
  if (u.username.startsWith("e2e_user_")) {
    console.log(`user ${u.username} -> ${await del(`/api/v1/users/${u.id}`)}`);
  }
}

// departments
const { departments } = await (await fetch(`${BASE}/api/v1/admin/departments`, { headers: H })).json();
for (const d of departments || []) {
  if (d.id.startsWith("e2e_dept_") || d.name.startsWith("E2E")) {
    console.log(`dept ${d.id} -> ${await del(`/api/v1/admin/departments/${d.id}`)}`);
  }
}

// mcp + skills
console.log(`mcp e2e-echo -> ${await del("/api/v1/admin/mcp/e2e-echo")}`);
const { skills } = await (await fetch(`${BASE}/api/v1/admin/skills`, { headers: H })).json();
for (const s of skills || []) {
  if (s.name === "e2e-skill" || s.id.startsWith("s_")) {
    // only e2e skill has this description marker
    if (String(s.description || "").includes("E2E-SKILL-LOADED") || s.name === "e2e-skill") {
      console.log(`skill ${s.id} -> ${await del(`/api/v1/admin/skills/${s.id}`)}`);
    }
  }
}
console.log("cleanup done,", n, "tasks removed");
