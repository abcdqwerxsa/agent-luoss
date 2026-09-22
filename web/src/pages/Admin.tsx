import React, { useEffect, useState } from "react";
import { api, auth, User, Scope, McpServerInfo, SkillInfo } from "../lib/api";
import { Select } from "../lib/select";
import { Icon } from "../lib/icons";

type Tab = "users" | "departments" | "models" | "mcp" | "skills" | "experts" | "usage" | "audit";

export function Admin() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>管理后台</h2>
          <p className="page-sub">用户 · 部门 · 模型 · MCP · Skills · 用量 · 审计</p>
        </div>
      </div>
      <div className="tabs">
        {(["users", "departments", "models", "mcp", "skills", "experts", "usage", "audit"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "sel" : ""}`} onClick={() => setTab(t)}>
            {{ users: "用户", departments: "部门", models: "模型", mcp: "MCP", skills: "Skills", experts: "专家", usage: "用量", audit: "审计" }[t]}
          </button>
        ))}
      </div>
      {tab === "users" && <UsersTab />}
      {tab === "departments" && <DepartmentsTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "mcp" && <McpTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "experts" && <ExpertsTab />}
      {tab === "usage" && <UsageTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

// ---- shared: scope editor (all | department:<id> | role:<name>) ----

function ScopeEditor({ depts, value, onChange }: { depts: { id: string; name: string }[]; value: Scope[]; onChange: (s: Scope[]) => void }) {
  const toggle = (s: Scope) => {
    const has = value.some((v) => v.type === s.type && v.value === s.value);
    onChange(has ? value.filter((v) => !(v.type === s.type && v.value === s.value)) : [...value, s]);
  };
  const opts: Scope[] = [{ type: "all", value: "" }, ...depts.map((d) => ({ type: "department", value: d.id })), { type: "role", value: "admin" }, { type: "role", value: "member" }];
  return (
    <span className="scope-editor">
      {opts.map((o, i) => {
        const on = value.some((v) => v.type === o.type && v.value === o.value);
        const label = o.type === "all" ? "全员" : o.type === "department" ? `部门:${depts.find((d) => d.id === o.value)?.name ?? o.value}` : `角色:${o.value}`;
        return (
          <button key={i} type="button" className={`chip ${on ? "chip-on" : ""}`} onClick={() => toggle(o)}>{label}</button>
        );
      })}
      {value.length === 0 && <span className="hint">（未选 = 全员可见）</span>}
    </span>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);
  const [quotas, setQuotas] = useState<Record<string, { limit: number; used: number }>>({});
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [display, setDisplay] = useState("");
  const [role, setRole] = useState("member");
  const [dept, setDept] = useState("");
  const [msg, setMsg] = useState("");
  const refresh = () => {
    api.admin.users().then((r) => setUsers(r.users)).catch((e) => setMsg(e.message));
    api.admin.departments().then((r) => setDepts(r.departments)).catch(() => {});
    api.admin.usage("?days=1").then((r) => {
      const m: Record<string, { limit: number; used: number }> = {};
      for (const q of r.quotas || []) m[q.user_id] = { limit: +q.monthly_limit_usd || 0, used: +q.month_used_usd || 0 };
      setQuotas(m);
    }).catch(() => {});
  };
  useEffect(() => { refresh(); }, []);
  const create = async () => {
    try { await api.admin.createUser({ username, password, display_name: display, role, department_id: dept }); setUsername(""); setPassword(""); setDisplay(""); setMsg("已创建"); refresh(); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="panel-card">
      <div className="inline-form">
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input placeholder="显示名" value={display} onChange={(e) => setDisplay(e.target.value)} />
        <Select value={role} onChange={setRole} options={[{ value: "member", label: "member" }, { value: "admin", label: "admin" }]} />
        <Select value={dept} onChange={setDept} options={[{ value: "", label: "无部门" }, ...depts.map((d) => ({ value: d.id, label: d.name }))]} />
        <button className="btn primary" disabled={!username || password.length < 8} onClick={create}><Icon name="plus" size={13} />创建</button>
        <span className="msg">{msg}</span>
      </div>
      <table>
        <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>部门</th><th>月度配额（$/月，0=∞）</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td><td>{u.display_name}</td>
              <td><Select value={u.role} onChange={(v) => api.admin.updateUser(u.id, { role: v }).then(refresh).catch((er) => setMsg(er.message))} options={[{ value: "member", label: "member" }, { value: "admin", label: "admin" }]} /></td>
              <td><Select value={u.department_id || ""} onChange={(v) => api.admin.updateUser(u.id, { department_id: v || "-" }).then(refresh).catch((er) => setMsg(er.message))} options={[{ value: "", label: "无部门" }, ...depts.map((d) => ({ value: d.id, label: d.name }))]} /></td>
              <td><QuotaCell id={u.id} q={quotas[u.id]} onSaved={refresh} /></td>
              <td><span className={`badge ${u.status === "active" ? "idle" : "failed"}`}>{u.status}</span></td>
              <td><button className="btn danger" onClick={() => confirm(`删除用户 ${u.username}？`) && api.admin.deleteUser(u.id).then(refresh).catch((er) => setMsg(er.message))}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QuotaCell({ id, q, onSaved }: { id: string; q?: { limit: number; used: number }; onSaved: () => void }) {
  const [v, setV] = useState("");
  const [saving, setSaving] = useState(false);
  const cur = q ? String(q.limit) : "";
  const shown = v === "" ? cur : v;
  const save = async () => {
    setSaving(true);
    try { await api.admin.setQuota(id, +shown || 0); onSaved(); } catch { /* list shows stale on failure */ }
    setSaving(false);
  };
  return (
    <div className="inline-form" style={{ gap: 4 }} data-tip={q ? `本月已用 $${(q.used || 0).toFixed(4)}` : ""} data-tip-down>
      <input type="number" placeholder="∞" value={shown} onChange={(e) => setV(e.target.value)} style={{ maxWidth: 84 }} />
      <button className="btn small" disabled={saving || shown === cur} onClick={save}>存</button>
    </div>
  );
}

function DepartmentsTab() {
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const refresh = () => api.admin.departments().then((r) => setDepts(r.departments)).catch((e) => setMsg(e.message));
  useEffect(() => { refresh(); }, []);
  return (
    <div className="panel-card">
      <div className="inline-form">
        <input placeholder="id (slug，可空自动生成)" value={id} onChange={(e) => setId(e.target.value)} />
        <input placeholder="部门名称" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name} onClick={() => api.admin.createDepartment({ id: id || undefined, name }).then(() => { setId(""); setName(""); setMsg("已创建"); refresh(); }).catch((e) => setMsg(e.message))}><Icon name="plus" size={13} />创建</button>
        <span className="msg">{msg}</span>
      </div>
      <table>
        <thead><tr><th>ID</th><th>名称</th><th>操作</th></tr></thead>
        <tbody>
          {depts.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.id}</td>
              <td><input defaultValue={d.name} onBlur={(e) => e.target.value !== d.name && api.admin.updateDepartment(d.id, e.target.value).then(refresh).catch((er) => setMsg(er.message))} /></td>
              <td><button className="btn danger" onClick={() => confirm(`删除部门 ${d.name}？该部门用户将变为无部门`) && api.admin.deleteDepartment(d.id).then(refresh).catch((er) => setMsg(er.message))}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelsTab() {
  const [providers, setProviders] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const [sel, setSel] = useState(""); // selected provider id
  const [pForm, setPForm] = useState({ id: "", name: "", base_url: "", api_type: "openai-completions", api_key: "", enabled: true });
  const [mForm, setMForm] = useState({ model_id: "", display_name: "", context_window: 128000, input_cost: 0, output_cost: 0 });
  const [fetched, setFetched] = useState<{ ids: string[]; pick: Record<string, boolean> } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [tests, setTests] = useState<Record<string, { ok?: boolean; latency_ms?: number; error?: string } | "testing">>({});

  const refresh = () => {
    api.admin.providers().then((r) => {
      setProviders(r.providers);
      setSel((s) => (s && r.providers.some((p: any) => p.id === s) ? s : r.providers[0]?.id || ""));
    }).catch((e) => setMsg(e.message));
    api.admin.allModels().then((r) => setModels(r.models || [])).catch(() => {});
  };
  useEffect(() => { refresh(); }, []);

  const mine = models.filter((m) => m.provider_id === sel);
  const existing = new Set(mine.map((m) => m.model_id));

  const addModel = (model_id: string) => {
    if (!sel || !model_id) return;
    api.admin.putModel({ provider_id: sel, model_id, display_name: "", context_window: 128000, enabled: true })
      .then(() => { setMsg(`已添加 ${model_id}`); setMForm({ model_id: "", display_name: "", context_window: 128000, input_cost: 0, output_cost: 0 }); refresh(); })
      .catch((e) => setMsg(e.message));
  };

  const toggle = (m: any) => {
    api.admin.putModel({
      provider_id: m.provider_id, model_id: m.model_id, display_name: m.display_name,
      context_window: m.context_window, input_cost: m.input_cost, output_cost: m.output_cost,
      reasoning: !!m.reasoning, enabled: !m.enabled, tier: m.tier || "",
    }).then(refresh).catch((e) => setMsg(e.message));
  };

  const setTier = (m: any, tier: string) => {
    api.admin.putModel({
      provider_id: m.provider_id, model_id: m.model_id, display_name: m.display_name,
      context_window: m.context_window, input_cost: m.input_cost, output_cost: m.output_cost,
      reasoning: !!m.reasoning, enabled: !!m.enabled, tier,
    }).then(refresh).catch((e) => setMsg(e.message));
  };

  const del = (m: any) => {
    confirm(`删除模型 ${m.provider_id}/${m.model_id}？`) &&
      api.admin.deleteModel(m.provider_id, m.model_id).then(refresh).catch((e) => setMsg(e.message));
  };

  const runTest = async (m: any) => {
    const key = `${m.provider_id}/${m.model_id}`;
    setTests((t) => ({ ...t, [key]: "testing" }));
    try {
      const r = await api.admin.testModel(m.provider_id, m.model_id);
      setTests((t) => ({ ...t, [key]: r }));
    } catch (e: any) {
      setTests((t) => ({ ...t, [key]: { ok: false, error: e.message } }));
    }
  };

  const testResult = (m: any) => {
    const t = tests[`${m.provider_id}/${m.model_id}`];
    if (t === "testing") return <span className="test-res testing">测试中…</span>;
    if (!t) return null;
    return t.ok
      ? <span className="test-res ok" data-tip={`${t.latency_ms}ms`}><Icon name="check" size={12} />{t.latency_ms}ms</span>
      : <span className="test-res err" data-tip={t.error}>失败</span>;
  };

  const fetchFromProvider = async () => {
    if (!sel) return;
    setFetching(true); setFetched(null); setMsg("");
    try {
      const r = await api.admin.fetchProviderModels(sel);
      const ids = r.model_ids || [];
      const pick: Record<string, boolean> = {};
      for (const id of ids) pick[id] = !existing.has(id); // new models pre-checked
      setFetched({ ids, pick });
      if (!ids.length) setMsg("服务端返回空列表");
    } catch (e: any) { setMsg(e.message); }
    setFetching(false);
  };

  const importPicked = async () => {
    if (!fetched) return;
    const ids = fetched.ids.filter((id) => fetched.pick[id]);
    for (const id of ids) {
      await api.admin.putModel({ provider_id: sel, model_id: id, display_name: "", context_window: 128000, enabled: true }).catch((e) => setMsg(e.message));
    }
    setMsg(`已导入 ${ids.length} 个模型`);
    setFetched(null);
    refresh();
  };

  const cur = providers.find((p) => p.id === sel);

  return (
    <div>
      <div className="panel-card">
        <h4><Icon name="plug" size={14} />Provider</h4>
        <div className="grid-form">
          <input placeholder="id (slug)" value={pForm.id} onChange={(e) => setPForm({ ...pForm, id: e.target.value })} />
          <input placeholder="显示名" value={pForm.name} onChange={(e) => setPForm({ ...pForm, name: e.target.value })} />
          <input placeholder="base_url (如 https://gw.internal/v1)" value={pForm.base_url} onChange={(e) => setPForm({ ...pForm, base_url: e.target.value })} />
          <Select value={pForm.api_type} onChange={(v) => setPForm({ ...pForm, api_type: v })} options={[{ value: "openai-completions", label: "openai-completions" }, { value: "anthropic-messages", label: "anthropic-messages" }]} />
          <input placeholder="API Key（留空=不改）" type="password" value={pForm.api_key} onChange={(e) => setPForm({ ...pForm, api_key: e.target.value })} />
          <label className="check"><input type="checkbox" checked={pForm.enabled} onChange={(e) => setPForm({ ...pForm, enabled: e.target.checked })} />启用</label>
          <button className="btn primary" disabled={!pForm.id || !pForm.base_url} onClick={() => api.admin.putProvider(pForm).then(() => { setMsg("已保存"); setPForm({ id: "", name: "", base_url: "", api_type: "openai-completions", api_key: "", enabled: true }); refresh(); }).catch((e) => setMsg(e.message))}>保存 Provider</button>
        </div>
        <div className="provider-cards">
          {providers.map((p) => (
            <button key={p.id} className={`provider-card ${sel === p.id ? "sel" : ""} ${p.enabled ? "" : "off"}`}
              onClick={() => { setSel(p.id); setFetched(null); setTests({}); }}>
              <span className="pc-name">{p.name || p.id}</span>
              <span className="pc-meta mono">{p.id} · {p.api_type}</span>
              <span className="pc-meta">{p.has_key ? "🔑 已配置密钥" : "⚠️ 无密钥"} · {models.filter((m) => m.provider_id === p.id).length} 模型</span>
              <span className={`badge ${p.enabled ? "idle" : "failed"}`}>{p.enabled ? "启用" : "停用"}</span>
              <span className="pc-del" onClick={(e) => { e.stopPropagation(); confirm(`删除 Provider ${p.id} 及其全部模型？`) && api.admin.deleteProvider(p.id).then(refresh).catch((er) => setMsg(er.message)); }}>删除</span>
            </button>
          ))}
        </div>
        {msg && <div className="msg">{msg}</div>}
      </div>

      {cur && (
        <div className="panel-card">
          <div className="model-head">
            <h4><Icon name="sparkles" size={14} />{cur.name || cur.id} 的模型</h4>
            <span className="spacer" />
            <button className="btn" disabled={fetching} onClick={fetchFromProvider}><Icon name="download" size={13} />{fetching ? "查询中…" : "从服务端获取模型"}</button>
          </div>

          {fetched && (
            <div className="fetch-box">
              <div className="fetch-head">
                <b>服务端模型（{fetched.ids.length}）</b>
                <span className="hint">新模型已勾选，重复导入无副作用</span>
                <span className="spacer" />
                <button className="btn primary" onClick={importPicked}>导入所选（{fetched.ids.filter((i) => fetched.pick[i]).length}）</button>
                <button className="btn" onClick={() => setFetched(null)}>取消</button>
              </div>
              <div className="fetch-list">
                {fetched.ids.map((id) => (
                  <label key={id} className={`check fetch-item ${existing.has(id) ? "exists" : ""}`}>
                    <input type="checkbox" checked={!!fetched.pick[id]} onChange={(e) => setFetched({ ...fetched, pick: { ...fetched.pick, [id]: e.target.checked } })} />
                    <span className="mono">{id}</span>
                    {existing.has(id) && <span className="hint">已存在</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          <table>
            <thead><tr><th>模型 ID</th><th>显示名</th><th>上下文</th><th>价格 in/out</th><th data-tip="Auto 路由分层：强=复杂任务，弱=简单任务，空=按推理标志自动归类">分层</th><th>测试</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {mine.map((m) => (
                <tr key={m.model_id} className={!m.enabled ? "row-off" : ""}>
                  <td className="mono">{m.model_id}</td>
                  <td>{m.display_name || <span className="hint">—</span>}</td>
                  <td>{m.context_window ? (+m.context_window / 1000).toFixed(0) + "k" : "—"}</td>
                  <td className="mono small">{!+ (m.input_cost || 0) && !+ (m.output_cost || 0) ? <span className="badge failed">未定价</span> : `${(+m.input_cost || 0)} / ${(+m.output_cost || 0)}`}</td>
                  <td>
                    <Select
                      className="tier-select"
                      value={m.tier || ""}
                      onChange={(v) => setTier(m, v)}
                      title="Auto 路由分层：强=复杂任务，弱=简单任务，自动=按推理标志归类"
                      options={[
                        { value: "", label: "自动" },
                        { value: "strong", label: "强" },
                        { value: "weak", label: "弱" },
                      ]}
                    />
                  </td>
                  <td>
                    <button className="btn small" onClick={() => runTest(m)}>测试</button>
                    {testResult(m)}
                  </td>
                  <td>
                    <label className="switch" data-tip={m.enabled ? "点击停用" : "点击启用"}>
                      <input type="checkbox" checked={!!m.enabled} onChange={() => toggle(m)} />
                      <span className="slider" />
                    </label>
                  </td>
                  <td><button className="btn danger small" onClick={() => del(m)}>删除</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="inline-form" style={{ marginTop: 10 }}>
            <input placeholder="手动添加 model id" value={mForm.model_id} onChange={(e) => setMForm({ ...mForm, model_id: e.target.value })} />
            <input placeholder="显示名（可空）" value={mForm.display_name} onChange={(e) => setMForm({ ...mForm, display_name: e.target.value })} />
            <input type="number" placeholder="context" value={mForm.context_window} onChange={(e) => setMForm({ ...mForm, context_window: +e.target.value })} style={{ maxWidth: 110 }} />
            <input type="number" placeholder="$in/1M" value={mForm.input_cost} onChange={(e) => setMForm({ ...mForm, input_cost: +e.target.value })} style={{ maxWidth: 90 }} />
            <input type="number" placeholder="$out/1M" value={mForm.output_cost} onChange={(e) => setMForm({ ...mForm, output_cost: +e.target.value })} style={{ maxWidth: 90 }} />
            <button className="btn primary" disabled={!mForm.model_id} onClick={() => addModel(mForm.model_id)}><Icon name="plus" size={13} />添加</button>
          </div>
        </div>
      )}
    </div>
  );
}

function McpTab() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(false);
  const empty = { id: "", name: "", transport: "stdio", command: "", args: "", url: "", env: "", enabled: true };
  const [form, setForm] = useState(empty);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const refresh = () => {
    api.admin.mcp().then((r) => setServers(r.servers || [])).catch((e) => setMsg(e.message));
    api.admin.departments().then((r) => setDepts(r.departments || [])).catch(() => {});
  };
  useEffect(() => { refresh(); }, []);

  const scopeLabel = (s: Scope) =>
    s.type === "all" ? "全员" : s.type === "department" ? `部门:${depts.find((d) => d.id === s.value)?.name ?? s.value}` : `角色:${s.value}`;
  const scopeSummary = (list: Scope[]) => (list?.length ? list.map(scopeLabel).join(" · ") : "全员");

  const startNew = () => { setForm(empty); setScopes([]); setEditing(true); setMsg(""); };
  const startEdit = (m: McpServerInfo) => {
    setForm({ id: m.id, name: m.name, transport: m.transport, command: m.command, args: (m.args || []).join(" "), url: m.url, env: "", enabled: m.enabled });
    setScopes(m.scopes || []); setEditing(true); setMsg("");
  };
  const save = () => {
    const env: Record<string, string> = {};
    for (const line of form.env.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    api.admin.putMcp({
      id: form.id, name: form.name, transport: form.transport,
      command: form.command, args: form.args.split(/\s+/).filter(Boolean), env, url: form.url,
      enabled: form.enabled, scopes,
    }).then(() => { setMsg("已保存，新会话生效"); setEditing(false); refresh(); }).catch((e) => setMsg(e.message));
  };
  const toggle = (m: McpServerInfo) => {
    api.admin.putMcp({
      id: m.id, name: m.name, transport: m.transport, command: m.command,
      args: m.args || [], env: {}, url: m.url, enabled: !m.enabled,
      scopes: m.scopes || [],
    }).then(refresh).catch((e) => setMsg(e.message));
  };
  const del = (m: McpServerInfo) => {
    confirm(`删除 MCP 服务器 ${m.name || m.id}？`) &&
      api.admin.deleteMcp(m.id).then(refresh).catch((e) => setMsg(e.message));
  };

  return (
    <div>
      <div className="panel-card">
        <div className="model-head">
          <h4><Icon name="plug" size={14} />MCP 服务器</h4>
          <span className="hint">stdio / http / sse · 密钥加密存储 · 改动对新会话生效</span>
          <span className="spacer" />
          <button className="btn primary" onClick={startNew}><Icon name="plus" size={13} />添加</button>
        </div>
        {msg && <div className="msg">{msg}</div>}
        <div className="provider-cards">
          {servers.map((m) => (
            <div key={m.id} className={`provider-card ${m.enabled ? "" : "off"}`} onClick={() => startEdit(m)} data-tip="点击编辑">
              <span className="pc-del" onClick={(e) => { e.stopPropagation(); del(m); }}>删除</span>
              <span className="pc-name">{m.name || m.id} <span className="badge">{m.transport}</span></span>
              <span className="pc-meta mono ellipsis">{m.transport === "stdio" ? `${m.command} ${(m.args || []).join(" ")}` : m.url}</span>
              <span className="pc-meta">👥 {scopeSummary(m.scopes)}</span>
              <div className="cap-actions" onClick={(e) => e.stopPropagation()}>
                <label className="switch" data-tip={m.enabled ? "停用" : "启用"}>
                  <input type="checkbox" checked={m.enabled} onChange={() => toggle(m)} />
                  <span className="slider" />
                </label>
                <span className="hint">{m.enabled ? "启用" : "停用"}</span>
              </div>
            </div>
          ))}
          {!servers.length && <div className="empty-hint">暂无 MCP 服务器，点击右上「添加」创建</div>}
        </div>
      </div>

      {editing && (
        <div className="panel-card">
          <div className="model-head">
            <h4><Icon name="edit" size={14} />{form.id && servers.some((s) => s.id === form.id) ? `编辑 ${form.id}` : "添加 MCP 服务器"}</h4>
            <span className="spacer" />
            <button className="btn" onClick={() => setEditing(false)}>收起</button>
          </div>
          <div className="grid-form">
            <input placeholder="id (slug)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
            <input placeholder="名称（agent 调用时引用）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select value={form.transport} onChange={(v) => setForm({ ...form, transport: v })} options={[{ value: "stdio", label: "stdio（本地命令）" }, { value: "http", label: "http（远程）" }, { value: "sse", label: "sse（远程）" }]} />
            {form.transport === "stdio" ? (
              <>
                <input placeholder="command (如 npx / node)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
                <input placeholder="args（空格分隔）" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
                <textarea placeholder="env（每行 KEY=value；留空=不改）" rows={2} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
              </>
            ) : (
              <input placeholder="url (https://.../mcp)" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            )}
            <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />启用</label>
            <button className="btn primary" disabled={!form.id} onClick={save}>保存</button>
          </div>
          <div className="form-row"><span>可见范围：</span><ScopeEditor depts={depts} value={scopes} onChange={setScopes} /></div>
        </div>
      )}
    </div>
  );
}

function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState("");
  const [id, setId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const refresh = () => {
    api.admin.skills().then((r) => setSkills(r.skills || [])).catch((e) => setMsg(e.message));
    api.admin.departments().then((r) => setDepts(r.departments || [])).catch(() => {});
  };
  useEffect(() => { refresh(); }, []);

  const scopeLabel = (s: Scope) =>
    s.type === "all" ? "全员" : s.type === "department" ? `部门:${depts.find((d) => d.id === s.value)?.name ?? s.value}` : `角色:${s.value}`;
  const scopeSummary = (list: Scope[]) => (list?.length ? list.map(scopeLabel).join(" · ") : "全员");

  const upload = async () => {
    if (!file) return;
    try {
      const r = await api.admin.uploadSkill(file, { id: id || undefined, enabled: true, scopes });
      setMsg(`已上传：${r.skill.name}（${r.skill.id}）`); setId(""); setFile(null); setScopes([]); refresh();
    } catch (e: any) { setMsg(e.message); }
  };
  const toggle = (k: SkillInfo) =>
    api.admin.putSkill({ id: k.id, enabled: !k.enabled, scopes: k.scopes || [] }).then(refresh).catch((e) => setMsg(e.message));
  const del = (k: SkillInfo) =>
    confirm(`删除技能 ${k.name}？`) && api.admin.deleteSkill(k.id).then(refresh).catch((e) => setMsg(e.message));

  return (
    <div>
      <div className="panel-card">
        <div className="model-head">
          <h4><Icon name="sparkles" size={14} />企业技能库</h4>
          <span className="hint">zip 包（根目录或单层目录内含 SKILL.md）</span>
        </div>
        <div className="upload-zone" onClick={() => document.getElementById("skill-file")?.click()}>
          <Icon name="upload" size={18} />
          <b>{file ? file.name : "点击选择 zip 文件"}</b>
          <span className="hint">{file ? "点击重新选择" : "上传后自动解析名称/描述"}</span>
          <input id="skill-file" type="file" accept=".zip" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        {file && (
          <>
            <div className="grid-form" style={{ marginTop: 10 }}>
              <input placeholder="id（可空自动生成）" value={id} onChange={(e) => setId(e.target.value)} />
              <button className="btn primary" onClick={upload}><Icon name="upload" size={13} />上传</button>
              <button className="btn" onClick={() => setFile(null)}>取消</button>
            </div>
            <div className="form-row"><span>可见范围：</span><ScopeEditor depts={depts} value={scopes} onChange={setScopes} /></div>
          </>
        )}
        {msg && <div className="msg">{msg}</div>}
        <div className="provider-cards">
          {skills.map((k) => (
            <div key={k.id} className={`provider-card ${k.enabled ? "" : "off"}`}>
              <span className="pc-del" onClick={() => del(k)}>删除</span>
              <span className="pc-name">{k.name}</span>
              <span className="pc-meta mono">{k.id}</span>
              <span className="pc-meta ellipsis" data-tip={k.description}>{k.description || "—"}</span>
              <span className="pc-meta">👥 {scopeSummary(k.scopes)}</span>
              <div className="cap-actions">
                <label className="switch" data-tip={k.enabled ? "停用" : "启用"}>
                  <input type="checkbox" checked={k.enabled} onChange={() => toggle(k)} />
                  <span className="slider" />
                </label>
                <span className="hint">{k.enabled ? "启用" : "停用"}</span>
              </div>
            </div>
          ))}
          {!skills.length && <div className="empty-hint">暂无技能，上传 zip 创建</div>}
        </div>
      </div>
    </div>
  );
}

function ExpertsTab() {
  const [experts, setExperts] = useState<any[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcps, setMcps] = useState<McpServerInfo[]>([]);
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState(false);
  const empty = { id: "", name: "", description: "", enabled: true, skill_ids: [] as string[], mcp_ids: [] as string[] };
  const [form, setForm] = useState<any>(empty);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const refresh = () => {
    api.admin.experts().then((r) => setExperts(r.experts || [])).catch((e) => setMsg(e.message));
    api.admin.skills().then((r) => setSkills(r.skills || [])).catch(() => {});
    api.admin.mcp().then((r) => setMcps(r.servers || [])).catch(() => {});
    api.admin.departments().then((r) => setDepts(r.departments || [])).catch(() => {});
  };
  useEffect(() => { refresh(); }, []);

  const scopeSummary = (list: Scope[]) => !list?.length ? "全员" : list.map((s) => s.type === "all" ? "全员" : s.type === "department" ? `部门:${depts.find((d) => d.id === s.value)?.name ?? s.value}` : `角色:${s.value}`).join(" · ");
  const toggleMember = (kind: "skill_ids" | "mcp_ids", id: string) =>
    setForm((f: any) => ({ ...f, [kind]: f[kind].includes(id) ? f[kind].filter((x: string) => x !== id) : [...f[kind], id] }));
  const save = () =>
    api.admin.putExpert({ ...form, scopes }).then(() => { setMsg("已保存"); setEditing(false); refresh(); }).catch((e) => setMsg(e.message));

  return (
    <div>
      <div className="panel-card">
        <div className="model-head">
          <h4><Icon name="sparkles" size={14} />专家（预装技能/MCP 组合，用户一键选用）</h4>
          <span className="spacer" />
          <button className="btn primary" onClick={() => { setForm(empty); setScopes([]); setEditing(true); }}><Icon name="plus" size={13} />添加</button>
        </div>
        {msg && <div className="msg">{msg}</div>}
        <table>
          <thead><tr><th>名称 / ID</th><th>类别</th><th>描述</th><th>构成</th><th>可见范围</th><th>状态</th><th style={{ width: 130 }}>操作</th></tr></thead>
          <tbody>
            {experts.map((e) => (
              <tr key={e.id} className={e.enabled ? "" : "off"}>
                <td><b>{e.name}</b><div className="mono pc-meta">{e.id}</div></td>
                <td>{e.name.includes("·") ? e.name.split("·")[0] : "—"}</td>
                <td className="ellipsis" style={{ maxWidth: 260 }} data-tip={e.description}>{e.description || "—"}</td>
                <td>技能×{e.skill_ids?.length || 0} · MCP×{e.mcp_ids?.length || 0}</td>
                <td>{scopeSummary(e.scopes)}</td>
                <td>
                  <label className="switch" data-tip={e.enabled ? "下架" : "上架"}>
                    <input type="checkbox" checked={e.enabled} onChange={() => api.admin.putExpert({ ...e, enabled: !e.enabled, scopes: e.scopes || [] }).then(refresh).catch((er) => setMsg(er.message))} />
                    <span className="slider" />
                  </label>
                </td>
                <td>
                  <div className="cap-actions">
                    <button className="btn small" onClick={() => { setForm({ id: e.id, name: e.name, description: e.description, enabled: e.enabled, skill_ids: e.skill_ids || [], mcp_ids: e.mcp_ids || [] }); setScopes(e.scopes || []); setEditing(true); }}>编辑</button>
                    <button className="btn small" onClick={() => confirm(`删除专家 ${e.name}？`) && api.admin.deleteExpert(e.id).then(refresh).catch((er) => setMsg(er.message))}>删除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!experts.length && <div className="empty-hint">暂无专家，点击右上「添加」创建（如 doc-master）</div>}
      </div>

      {editing && (
        <div className="panel-card">
          <div className="model-head">
            <h4><Icon name="edit" size={14} />{experts.some((e) => e.id === form.id) ? `编辑 ${form.id}` : "添加专家"}</h4>
            <span className="spacer" />
            <button className="btn" onClick={() => setEditing(false)}>收起</button>
          </div>
          <div className="grid-form">
            <input placeholder="id (slug，如 doc-master)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
            <input placeholder="名称（用户可见）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="一句话描述（如：一键生成专业排版的 PPT/PDF）" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="form-row"><span>绑定技能：</span>
            {skills.map((k) => (
              <button key={k.id} type="button" className={`chip ${form.skill_ids.includes(k.id) ? "chip-on" : ""}`} onClick={() => toggleMember("skill_ids", k.id)}>{k.name}</button>
            ))}
            {!skills.length && <span className="hint">（先在 Skills 上传）</span>}
          </div>
          <div className="form-row"><span>绑定 MCP：</span>
            {mcps.map((m) => (
              <button key={m.id} type="button" className={`chip ${form.mcp_ids.includes(m.id) ? "chip-on" : ""}`} onClick={() => toggleMember("mcp_ids", m.id)}>{m.name || m.id}</button>
            ))}
            {!mcps.length && <span className="hint">（先在 MCP 添加）</span>}
          </div>
          <div className="form-row"><span>可见范围：</span><ScopeEditor depts={depts} value={scopes} onChange={setScopes} /></div>
          <div className="row-end">
            <button className="btn primary" disabled={!form.id || !form.name} onClick={save}>保存</button>
          </div>
        </div>
      )}
    </div>
  );
}

function UsageTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [byModel, setByModel] = useState<any[]>([]);
  const [topUsers, setTopUsers] = useState<any[]>([]);
  const [dims, setDims] = useState<any>({});
  const [unpriced, setUnpriced] = useState<any[]>([]);
  const [mine, setMine] = useState<any>(null);
  const [days, setDays] = useState(7);
  useEffect(() => {
    api.admin.usage(`?days=${days}`).then((r) => {
      setRows(r.rows || []); setByModel(r.by_model || []); setTopUsers(r.top_users || []); setDims(r);
    }).catch(() => {});
    api.usageMe().then(setMine).catch(() => {});
    api.models().then((r) => setUnpriced((r.models || []).filter((m) => !+(m.input_cost || 0) && !+(m.output_cost || 0)))).catch(() => {});
  }, [days]);

  // aggregate by day for chart + totals
  const byDay = new Map<string, { tokens: number; cost: number }>();
  for (const r of rows) {
    const d = byDay.get(r.day) || { tokens: 0, cost: 0 };
    d.tokens += +r.total_tokens || 0;
    d.cost += +r.cost_usd || 0;
    byDay.set(r.day, d);
  }
  const dayList: { day: string; label: string; tokens: number; cost: number; today: boolean }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const d = byDay.get(key);
    dayList.push({ day: key, label: days > 14 ? `${dt.getMonth() + 1}/${dt.getDate()}` : `${dt.getDate()}日`, tokens: d?.tokens || 0, cost: d?.cost || 0, today: i === 0 });
  }
  const maxTokens = Math.max(...dayList.map((d) => d.tokens), 1);
  const usedPct = mine && mine.month_limit_usd > 0 ? Math.min(100, (mine.month_used_usd / mine.month_limit_usd) * 100) : 0;
  const fmt = (n: number) => (+n || 0).toLocaleString();

  return (
    <div>
      <div className="inline-form" style={{ marginBottom: 12 }}>
        <b>统计范围</b>
        {[7, 30, 90].map((d) => (
          <button key={d} className={`btn ${days === d ? "primary" : ""}`} onClick={() => setDays(d)}>{d} 天</button>
        ))}
        <span className="spacer" />
        <a className="btn" href={`/api/v1/admin/usage/export?days=${days}&access_token=${encodeURIComponent(auth.token)}`} target="_blank" rel="noreferrer">导出 CSV</a>
      </div>

      {!!unpriced.length && (
        <div className="panel-card" style={{ borderLeft: "3px solid #e6a23c" }}>
          <b>⚠ {unpriced.length} 个模型未定价</b>：{unpriced.map((m) => m.model_id).join("、")} —— 用量将继续记录 tokens，但费用恒为 $0。请到「模型」页补填价格（$/1M tokens）。
        </div>
      )}

      <div className="panel-card" style={{ display: "flex", gap: 24 }}>
        <span><b className="mono" style={{ fontSize: 22 }}>{dims.dau ?? "—"}</b><span className="hint"> 今日活跃</span></span>
        <span><b className="mono" style={{ fontSize: 22 }}>{dims.wau ?? "—"}</b><span className="hint"> 7 日活跃</span></span>
        <span><b className="mono" style={{ fontSize: 22 }}>{dims.mau ?? "—"}</b><span className="hint"> 30 日活跃</span></span>
      </div>

      {mine && (
        <div className="quota card">
          <div className="quota-head"><b>本月个人额度</b><span className="mono">${(mine.month_used_usd || 0).toFixed(4)} / ${mine.month_limit_usd > 0 ? mine.month_limit_usd.toFixed(2) : "∞"}</span></div>
          {mine.month_limit_usd > 0 && <div className="bar"><div className="bar-fill" style={{ width: `${usedPct}%` }} /></div>}
        </div>
      )}

      <div className="usage-chart card">
        <div className="chart-head"><b>近 {days} 日 Tokens</b><span className="spacer" /><span className="mono chart-sum">{dayList.reduce((s, d) => s + d.cost, 0).toFixed(4)} USD</span></div>
        <div className="chart-plot">
          {dayList.map((d) => (
            <div key={d.day} className={`chart-col ${d.today ? "today" : ""}`}>
              <span className="chart-val">{d.tokens > 0 ? fmt(d.tokens) : ""}</span>
              <div className="chart-bar" style={{ height: `${Math.max(3, (d.tokens / maxTokens) * 130)}px` }} data-tip={`${d.day} · $${d.cost.toFixed(6)}`} />
              <span className="chart-day">{d.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel-card">
        <h4><Icon name="sparkles" size={14} />模型维度</h4>
        <table>
          <thead><tr><th>Provider</th><th>模型</th><th>Input</th><th>Output</th><th>Cache R/W</th><th>合计</th><th>费用</th><th>任务数</th></tr></thead>
          <tbody>
            {byModel.map((m, i) => (
              <tr key={i}>
                <td>{m.provider}</td><td className="mono">{m.model_id}</td>
                <td>{fmt(m.input_tokens)}</td><td>{fmt(m.output_tokens)}</td>
                <td>{fmt(m.cache_read_tokens)} / {fmt(m.cache_write_tokens)}</td>
                <td>{fmt(m.total_tokens)}</td><td>${(+m.cost_usd || 0).toFixed(6)}</td><td>{m.task_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel-card">
        <h4><Icon name="user" size={14} />用户排行（Top 20，按费用）</h4>
        <table>
          <thead><tr><th>#</th><th>用户</th><th>Tokens</th><th>费用</th><th>任务数</th></tr></thead>
          <tbody>
            {topUsers.map((u, i) => (
              <tr key={i}><td>{i + 1}</td><td className="mono small">{u.user_id?.slice(0, 10)}</td><td>{fmt(u.total_tokens)}</td><td>${(+u.cost_usd || 0).toFixed(6)}</td><td>{u.task_count}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel-card">
        <h4><Icon name="sparkles" size={14} />专家维度</h4>
        <table>
          <thead><tr><th>专家</th><th>ID</th><th>Tokens</th><th>费用</th><th>任务数</th></tr></thead>
          <tbody>
            {(dims.by_expert || []).map((e: any, i: number) => (
              <tr key={i}><td>{e.name}</td><td className="mono small">{e.expert_id}</td><td>{fmt(e.total_tokens)}</td><td>${(+e.cost_usd || 0).toFixed(6)}</td><td>{e.task_count}</td></tr>
            ))}
            {!(dims.by_expert || []).length && <tr><td colSpan={5} className="hint">暂无专家维度数据（仅统计新会话）</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel-card">
        <h4><Icon name="user" size={14} />部门维度</h4>
        <table>
          <thead><tr><th>部门</th><th>Tokens</th><th>费用</th><th>人数</th><th>任务数</th></tr></thead>
          <tbody>
            {(dims.by_department || []).map((d: any, i: number) => (
              <tr key={i}><td>{d.department}</td><td>{fmt(d.total_tokens)}</td><td>${(+d.cost_usd || 0).toFixed(6)}</td><td>{d.users}</td><td>{d.task_count}</td></tr>
            ))}
            {!(dims.by_department || []).length && <tr><td colSpan={5} className="hint">暂无数据</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel-card">
        <h4><Icon name="zap" size={14} />高消耗任务（Top 20，按费用）</h4>
        <table>
          <thead><tr><th>任务</th><th>标题</th><th>用户</th><th>Tokens</th><th>费用</th></tr></thead>
          <tbody>
            {(dims.by_task || []).map((t: any, i: number) => (
              <tr key={t.task_id}>
                <td><a className="mono small" href={`#/task/${t.task_id}`}>{t.task_id?.slice(0, 14)}…</a></td>
                <td>{t.title?.slice(0, 24) || "—"}</td><td className="mono small">{t.user_id?.slice(0, 10)}</td>
                <td>{fmt(t.total_tokens)}</td><td>${(+t.cost_usd || 0).toFixed(6)}</td>
              </tr>
            ))}
            {!(dims.by_task || []).length && <tr><td colSpan={5} className="hint">暂无数据</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel-card">
        <h4><Icon name="plug" size={14} />工具调用 Top 20</h4>
        <table>
          <thead><tr><th>工具</th><th>调用次数</th></tr></thead>
          <tbody>
            {(dims.by_tool || []).map((t: any, i: number) => (
              <tr key={i}><td className="mono">{t.tool}</td><td>{fmt(t.calls)}</td></tr>
            ))}
            {!(dims.by_tool || []).length && <tr><td colSpan={2} className="hint">暂无数据（仅统计新会话）</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel-card">
        <h4>明细（用户 × 日）</h4>
        <table>
          <thead><tr><th>日期</th><th>用户</th><th>Tokens</th><th>费用</th><th>任务数</th></tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}><td>{r.day}</td><td className="mono small">{r.user_id?.slice(0, 10)}</td><td>{fmt(r.total_tokens)}</td><td>${(+r.cost_usd || 0).toFixed(6)}</td><td>{r.task_count}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const AUDIT_ACTIONS = ["auth.login", "task.create", "task.abort", "task.delete", "user.create", "user.update", "user.delete", "iam.dept_create", "iam.dept_update", "iam.dept_delete", "model.upsert_provider", "model.upsert_model", "model.delete_provider", "model.delete_model", "caps.mcp_upsert", "caps.mcp_delete", "caps.skill_upload", "caps.skill_update", "caps.skill_delete", "caps.expert_upsert", "caps.expert_delete"];

function AuditTab() {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [resource, setResource] = useState("");
  const LIMIT = 50;
  const load = () => {
    const p = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    if (action) p.set("action", action);
    if (actor.trim()) p.set("actor", actor.trim());
    if (resource.trim()) p.set("resource", resource.trim());
    api.admin.audit("?" + p.toString()).then((r) => { setLogs(r.logs || []); setTotal(r.total || 0); }).catch(() => {});
  };
  useEffect(() => { load(); }, [action, offset]);
  const exportQ = `action=${action}&actor=${encodeURIComponent(actor.trim())}&resource=${encodeURIComponent(resource.trim())}&limit=5000&access_token=${encodeURIComponent(auth.token)}`;
  return (
    <div className="panel-card">
      <div className="inline-form">
        <Select value={action} onChange={(v) => { setAction(v); setOffset(0); }} options={[{ value: "", label: "全部动作" }, ...AUDIT_ACTIONS.map((a) => ({ value: a, label: a }))]} />
        <input placeholder="操作者 user id" value={actor} onChange={(e) => setActor(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (setOffset(0), load())} style={{ maxWidth: 160 }} />
        <input placeholder="资源关键字（如 task/）" value={resource} onChange={(e) => setResource(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (setOffset(0), load())} style={{ maxWidth: 180 }} />
        <button className="btn" onClick={() => { setOffset(0); load(); }}>查询</button>
        <span className="spacer" />
        <a className="btn" href={`/api/v1/admin/audit?${exportQ}`} target="_blank" rel="noreferrer">导出 CSV</a>
      </div>
      <table>
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>资源</th><th>IP</th></tr></thead>
        <tbody>
          {logs.map((l) => <tr key={l.id}><td>{new Date(l.ts).toLocaleString()}</td><td>{l.actor?.slice(0, 10)}</td><td><span className="mono">{l.action}</span></td><td>{l.resource}</td><td>{l.ip}</td></tr>)}
          {!logs.length && <tr><td colSpan={5} className="hint">无匹配记录</td></tr>}
        </tbody>
      </table>
      <div className="inline-form" style={{ marginTop: 8 }}>
        <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>上一页</button>
        <span className="hint">{total ? `${offset + 1}–${Math.min(offset + LIMIT, total)} / 共 ${total} 条` : "0 条"}</span>
        <button className="btn small" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>下一页</button>
      </div>
    </div>
  );
}
