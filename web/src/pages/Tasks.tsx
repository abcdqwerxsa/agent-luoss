import React, { useEffect, useState } from "react";
import { api, TaskInfo, ModelOpt } from "../lib/api";

const MODES = [
  { id: "ask", name: "问一问", desc: "只读，不修改文件" },
  { id: "craft", name: "做一做", desc: "直接执行任务" },
  { id: "plan", name: "想一想", desc: "先出计划，确认后执行" },
];

export function Tasks() {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState("craft");
  const [modelKey, setModelKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const r = await api.tasks.list(q ? `?q=${encodeURIComponent(q)}` : "");
      setTasks(r.tasks);
    } catch (e: any) { setErr(e.message); }
  };

  useEffect(() => { refresh(); }, [q]);
  useEffect(() => {
    api.models().then((r) => {
      setModels(r.models);
      if (r.models.length) setModelKey(`${r.models[0].provider_id}/${r.models[0].model_id}`);
    }).catch(() => {});
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    const [provider, model_id] = modelKey.split("/");
    setBusy(true); setErr("");
    try {
      const r = await api.tasks.create({ title, mode, provider, model_id, first_message: message });
      location.hash = `#/task/${r.task.id}`;
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const statusBadge = (s: string) => <span className={`badge ${s}`}>{{ pending: "待处理", running: "执行中", idle: "空闲", failed: "失败", archived: "已归档" }[s] || s}</span>;

  return (
    <div className="page">
      <div className="page-head">
        <h2>任务</h2>
        <input className="search" placeholder="搜索任务…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary" onClick={() => setCreating(true)}>新建任务</button>
      </div>

      {creating && (
        <div className="new-task card">
          <input placeholder="标题（可留空，自动取首条消息）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="modes">
            {MODES.map((m) => (
              <button key={m.id} className={`mode ${mode === m.id ? "sel" : ""}`} onClick={() => setMode(m.id)}>
                <b>{m.name}</b><span>{m.desc}</span>
              </button>
            ))}
          </div>
          <select value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
            {models.map((m) => <option key={`${m.provider_id}/${m.model_id}`} value={`${m.provider_id}/${m.model_id}`}>{m.display_name || `${m.provider_id}/${m.model_id}`}</option>)}
          </select>
          <textarea rows={4} placeholder="描述任务…（支持上传文件到工作区后要求处理）" value={message} onChange={(e) => setMessage(e.target.value)} />
          {err && <div className="error">{err}</div>}
          <div className="row-end">
            <button className="btn ghost" onClick={() => setCreating(false)}>取消</button>
            <button className="btn primary" disabled={busy || !message || !modelKey} onClick={create}>{busy ? "创建中…" : "创建并执行"}</button>
          </div>
        </div>
      )}

      <div className="task-list">
        {tasks.length === 0 && <div className="empty">暂无任务，点击右上角新建</div>}
        {tasks.map((t) => (
          <div key={t.id} className="task-row card" onClick={() => (location.hash = `#/task/${t.id}`)}>
            <div className="t-main">
              <div className="t-title">{t.title || t.first_message || "(未命名)"}</div>
              <div className="t-meta">
                {statusBadge(t.status)}
                <span className="chip">{t.mode}</span>
                <span className="chip">{t.model_id}</span>
                <span className="time">{new Date(t.updated_at).toLocaleString()}</span>
              </div>
            </div>
            <span className="arrow">→</span>
          </div>
        ))}
      </div>
    </div>
  );
}
