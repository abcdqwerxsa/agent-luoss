// Concurrency load test: N tasks created in parallel, each SSE-watched to
// settled. Reports success rate, wall time and runtime distribution.
//   node deploy/load.mjs [N] [BASE]
// Prereq: login token for admin; provider+model seeded.
const N = parseInt(process.argv[2] || "20", 10);
const BASE = process.argv[3] || "http://gateway:8080";

async function main() {
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD || "admin12345" }),
  });
  const { access_token: tok } = await login.json();
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${tok}` };
  const models = await (await fetch(`${BASE}/api/v1/models`, { headers: H })).json();
  if (!models.models?.length) throw new Error("no models; seed provider first");
  const m = models.models[0];

  console.log(`firing ${N} concurrent tasks on ${m.provider_id}/${m.model_id}…`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => runOne(H, m, i)),
  );
  const okc = results.filter((r) => r.status === "fulfilled" && r.value).length;
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`done: ${okc}/${N} settled ok in ${wall}s`);

  // runtime distribution from task rows (via list)
  const list = await (await fetch(`${BASE}/api/v1/tasks?all=true&limit=200`, { headers: H })).json();
  const done = (list.tasks || []).filter((t) => t.updated_at > t0 - 1000);
  console.log(`recent tasks: ${done.length}`);
  const fails = results.filter((r) => r.status === "rejected" || !r.value);
  for (const f of fails.slice(0, 5)) {
    console.log("fail:", f.reason?.message || f.reason || "no settle");
  }
  process.exit(okc === N ? 0 : 1);
}

async function runOne(H, m, i) {
  let task;
  for (let a = 0; a < 10; a++) {
    try {
      const ct = await fetch(`${BASE}/api/v1/tasks`, {
        method: "POST", headers: H,
        body: JSON.stringify({
          title: `load-${i}`, mode: "ask", provider: m.provider_id, model_id: m.model_id,
          first_message: `只回答数字 ${i}`,
        }),
      });
      if (ct.status === 429) { await sleep(500 + a * 500); continue; }
      if (!ct.ok) throw new Error(`create ${ct.status}`);
      task = (await ct.json()).task;
      break;
    } catch (e) { if (a === 9) throw e; await sleep(500); }
  }
  if (!task) throw new Error("create failed");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 300_000);
  try {
    let res;
    for (let a = 0; a < 20; a++) {
      res = await fetch(`${BASE}/api/v1/tasks/${task.id}/events?access_token=${encodeURIComponent(H.Authorization.slice(7))}`, { signal: ctl.signal });
      if (res.ok) break;
      if (res.status === 429) { await sleep(500 + a * 500); continue; }
      throw new Error(`sse ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dl = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dl) continue;
        const ev = JSON.parse(dl.slice(6));
        if (ev.type === "agent_settled") return true;
        if (ev.type === "error") throw new Error(ev.payload?.message || "error event");
      }
    }
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error("load crash:", e.message); process.exit(1); });
