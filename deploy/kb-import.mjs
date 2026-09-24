// Bulk-import a directory of documents into a knowledge base.
// Usage: node kb-import.mjs <gateway-base> <kb-id> <dir> [concurrency=4]
// Walks dir recursively; uploads via admin API; waits for ingest to settle.
import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";

const [BASE, KB_ID, DIR, CONC = "4"] = process.argv.slice(2);
if (!BASE || !KB_ID || !DIR) {
  console.error("usage: node kb-import.mjs <gateway-base> <kb-id> <dir> [concurrency]");
  process.exit(2);
}
const login = await (await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "admin12345" }),
})).json();
const H = { Authorization: `Bearer ${login.access_token}` };

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = (await walk(DIR)).filter((f) => !f.startsWith("."));
console.log(`importing ${files.length} files from ${DIR} -> kb ${KB_ID}`);

let done = 0, failed = 0;
const queue = [...files];
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const content = await readFile(f);
    const fd = new FormData();
    fd.append("file", new Blob([content]), f.split("/").pop());
    const res = await fetch(`${BASE}/api/v1/admin/kb/${KB_ID}/docs`, { method: "POST", headers: H, body: fd });
    if (!res.ok) {
      failed++;
      console.error(`FAIL ${f}: ${(await res.json().catch(() => ({}))).error || res.status}`);
    }
    if (++done % 20 === 0) console.log(`  uploaded ${done}/${files.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(+CONC, files.length) }, worker));
console.log(`uploaded: ${files.length - failed} ok, ${failed} failed`);

// wait for ingestion to settle
console.log("waiting for ingest…");
for (let round = 0; round < 360; round++) {
  await new Promise((r) => setTimeout(r, 5000));
  const { docs } = await (await fetch(`${BASE}/api/v1/admin/kb/${KB_ID}/docs`, { headers: H })).json();
  const pending = (docs || []).filter((d) => d.status === "parsing").length;
  const ok = (docs || []).filter((d) => d.status === "ready").length;
  const bad = (docs || []).filter((d) => d.status === "failed");
  if (round % 6 === 0) console.log(`  ready=${ok} parsing=${pending} failed=${bad.length}`);
  if (pending === 0) {
    console.log(`done: ready=${ok} failed=${bad.length}`);
    for (const d of bad.slice(0, 10)) console.error(`  ${d.filename}: ${d.error}`);
    process.exit(bad.length ? 1 : 0);
  }
}
console.error("timed out waiting for ingest");
process.exit(1);
