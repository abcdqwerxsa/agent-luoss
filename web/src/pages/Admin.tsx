import React, { useEffect, useState } from "react";
import { api, User } from "../lib/api";

type Tab = "users" | "models" | "usage" | "audit";

export function Admin() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <div className="page">
      <div className="page-head">
        <h2>管理后台</h2>
      </div>
      <div className="tabs">
        {(["users", "models", "usage", "audit"] as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "sel" : ""}`} onClick={() => setTab(t)}>
            {{ users: "用户", models: "模型", usage: "用量", audit: "审计" }[t]}
          </button>
        ))}
      </div>
      {tab === "users" && <UsersTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "usage" && <UsageTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [display, setDisplay] = useState("");
  const [role, setRole] = useState("member");
  const [msg, setMsg] = useState("");
  const refresh = () => api.admin.users().then((r) => setUsers(r.users)).catch((e) => setMsg(e.message));
  useEffect(() => { refresh(); }, []);
  const create = async () => {
    try { await api.admin.createUser({ username, password, display_name: display, role }); setUsername(""); setPassword(""); setDisplay(""); setMsg("已创建"); refresh(); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div>
      <div className="inline-form">
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="密码(≥8位)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input placeholder="显示名" value={display} onChange={(e) => setDisplay(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value)}><option value="member">member</option><option value="admin">admin</option></select>
        <button className="btn primary" disabled={!username || password.length < 8} onClick={create}>创建</button>
        <span className="msg">{msg}</span>
      </div>
      <table>
        <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td><td>{u.display_name}</td>
              <td><select value={u.role} onChange={(e) => api.admin.updateUser(u.id, { role: e.target.value }).then(refresh).catch((er) => setMsg(er.message))}>
                <option value="member">member</option><option value="admin">admin</option>
              </select></td>
              <td><span className={`badge ${u.status === "active" ? "idle" : "failed"}`}>{u.status}</span></td>
              <td className="ops">
                <button className="btn ghost" onClick={() => api.admin.updateUser(u.id, { status: u.status === "active" ? "disabled" : "active" }).then(refresh).catch((er) => setMsg(er.message))}>
                  {u.status === "active" ? "禁用" : "启用"}
                </button>
                <button className="btn ghost" onClick={() => { if (confirm(`删除用户 ${u.username}?`)) api.admin.deleteUser(u.id).then(refresh).catch((er) => setMsg(er.message)); }}>删除</button>
              </td>
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
  const [pForm, setPForm] = useState({ id: "", name: "", base_url: "", api_type: "openai-completions", api_key: "", enabled: true });
  const [mForm, setMForm] = useState({ provider_id: "", model_id: "", display_name: "", context_window: 128000, input_cost: 0, output_cost: 0, enabled: true });
  const refresh = () => {
    api.admin.providers().then((r) => setProviders(r.providers)).catch((e) => setMsg(e.message));
    api.models().then((r) => setModels(r.models)).catch(() => {});
  };
  useEffect(() => { refresh(); }, []);
  return (
    <div>
      <h4>Provider（OpenAI 兼容网关）</h4>
      <div className="grid-form">
        <input placeholder="id (slug)" value={pForm.id} onChange={(e) => setPForm({ ...pForm, id: e.target.value })} />
        <input placeholder="名称" value={pForm.name} onChange={(e) => setPForm({ ...pForm, name: e.target.value })} />
        <input placeholder="Base URL, 如 https://gw.internal/v1" value={pForm.base_url} onChange={(e) => setPForm({ ...pForm, base_url: e.target.value })} />
        <input placeholder="API Key（保存后加密存储）" type="password" value={pForm.api_key} onChange={(e) => setPForm({ ...pForm, api_key: e.target.value })} />
        <select value={pForm.api_type} onChange={(e) => setPForm({ ...pForm, api_type: e.target.value })}>
          <option value="openai-completions">openai-completions</option>
          <option value="anthropic-messages">anthropic-messages</option>
        </select>
        <label className="check"><input type="checkbox" checked={pForm.enabled} onChange={(e) => setPForm({ ...pForm, enabled: e.target.checked })} />启用</label>
        <button className="btn primary" onClick={() => api.admin.putProvider(pForm).then(() => { setMsg("已保存"); refresh(); }).catch((e) => setMsg(e.message))}>保存 Provider</button>
      </div>

      <h4>模型</h4>
      <div className="grid-form">
        <select value={mForm.provider_id} onChange={(e) => setMForm({ ...mForm, provider_id: e.target.value })}>
          <option value="">选择 provider</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
        <input placeholder="model id (如 glm-5.3-flash)" value={mForm.model_id} onChange={(e) => setMForm({ ...mForm, model_id: e.target.value })} />
        <input placeholder="显示名" value={mForm.display_name} onChange={(e) => setMForm({ ...mForm, display_name: e.target.value })} />
        <input type="number" placeholder="context window" value={mForm.context_window} onChange={(e) => setMForm({ ...mForm, context_window: +e.target.value })} />
        <input type="number" step="0.01" placeholder="输入价格 $/1M" value={mForm.input_cost} onChange={(e) => setMForm({ ...mForm, input_cost: +e.target.value })} />
        <input type="number" step="0.01" placeholder="输出价格 $/1M" value={mForm.output_cost} onChange={(e) => setMForm({ ...mForm, output_cost: +e.target.value })} />
        <label className="check"><input type="checkbox" checked={mForm.enabled} onChange={(e) => setMForm({ ...mForm, enabled: e.target.checked })} />启用</label>
        <button className="btn primary" onClick={() => api.admin.putModel(mForm).then(() => { setMsg("已保存"); refresh(); }).catch((e) => setMsg(e.message))}>保存模型</button>
      </div>
      {msg && <div className="msg">{msg}</div>}

      <table>
        <thead><tr><th>Provider</th><th>模型</th><th>显示名</th><th>上下文</th></tr></thead>
        <tbody>
          {models.map((m) => <tr key={`${m.provider_id}/${m.model_id}`}><td>{m.provider_id}</td><td>{m.model_id}</td><td>{m.display_name}</td><td>{m.context_window}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function UsageTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [mine, setMine] = useState<any>(null);
  useEffect(() => {
    api.admin.usage().then((r) => setRows(r.rows || [])).catch(() => {});
    api.usageMe().then(setMine).catch(() => {});
  }, []);
  return (
    <div>
      {mine && <div className="usage-summary">
        本月用量：${mine.month_used_usd?.toFixed?.(4) ?? mine.month_used_usd} / 限额 ${mine.month_limit_usd}
      </div>}
      <table>
        <thead><tr><th>日期</th><th>用户</th><th>Tokens</th><th>费用</th><th>任务数</th></tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}><td>{r.day}</td><td>{r.user_id?.slice(0, 10)}</td><td>{r.total_tokens}</td><td>${(+r.cost_usd).toFixed(6)}</td><td>{r.task_count}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab() {
  const [logs, setLogs] = useState<any[]>([]);
  const [action, setAction] = useState("");
  useEffect(() => {
    api.admin.audit(action ? `?action=${action}` : "").then((r) => setLogs(r.logs || [])).catch(() => {});
  }, [action]);
  return (
    <div>
      <div className="inline-form">
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">全部动作</option>
          {["auth.login", "task.create", "task.abort", "task.delete", "user.create", "user.update", "user.delete", "model.upsert_provider", "model.upsert_model", "model.delete_provider", "model.delete_model"].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <table>
        <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>资源</th><th>IP</th></tr></thead>
        <tbody>
          {logs.map((l) => <tr key={l.id}><td>{new Date(l.ts).toLocaleString()}</td><td>{l.actor?.slice(0, 10)}</td><td>{l.action}</td><td>{l.resource}</td><td>{l.ip}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
