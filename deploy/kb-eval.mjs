// KB retrieval eval harness: measures lexical recall@k / MRR against a
// golden set. Usage: node kb-eval.mjs <gateway-base> <kb-id> <golden.jsonl>
// golden.jsonl lines: {"q": "报销需要几天内提交？", "expect_doc": "handbook"} (title/filename substring)
// Optionally "expect_section": "报销" (heading substring, section-level credit).
const [BASE, KB_ID, GOLDEN] = process.argv.slice(2);
if (!BASE || !KB_ID || !GOLDEN) {
  console.error("usage: node kb-eval.mjs <gateway-base> <kb-id> <golden.jsonl>");
  process.exit(2);
}
const { readFile } = await import("node:fs/promises");

const login = await (await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "admin12345" }),
})).json();
const H = { Authorization: `Bearer ${login.access_token}` };

const cases = (await readFile(GOLDEN, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
console.log(`evaluating ${cases.length} questions on kb ${KB_ID}`);

let recall1 = 0, recall5 = 0, mrr = 0, misses = [];
for (const c of cases) {
  const r = await (await fetch(`${BASE}/api/v1/admin/kb/${KB_ID}/search?q=${encodeURIComponent(c.q)}&top_k=5`, { headers: H })).json();
  const hits = r.hits || [];
  const hit = (h: any) =>
    (h.title || "").includes(c.expect_doc) ||
    (c.expect_section ? (h.section || "").includes(c.expect_section) : false);
  const ranks = hits.map(hit).map((ok, i) => (ok ? i + 1 : 0)).filter((n) => n > 0);
  if (ranks[0] === 1) recall1++;
  if (ranks.length) recall5++;
  if (ranks[0]) mrr += 1 / ranks[0];
  else misses.push(c.q);
}
const n = cases.length || 1;
console.log(`recall@1: ${(recall1 / n).toFixed(2)}  recall@5: ${(recall5 / n).toFixed(2)}  MRR: ${(mrr / n).toFixed(2)}`);
if (misses.length) {
  console.log("misses:");
  for (const q of misses.slice(0, 20)) console.log(`  - ${q}`);
}
