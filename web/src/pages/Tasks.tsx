import React, { useEffect, useState } from "react";
import { api, TaskInfo, ModelOpt } from "../lib/api";
import { Icon } from "../lib/icons";
import { Select } from "../lib/select";

const MODES = [
  { id: "ask", name: "问一问", desc: "只读，不修改文件", icon: "eye" },
  { id: "craft", name: "做一做", desc: "直接执行任务", icon: "hammer" },
  { id: "plan", name: "想一想", desc: "先出计划，确认后执行", icon: "map" },
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
  const [experts, setExperts] = useState<{ id: string; name: string; description: string; skill_ids?: string[]; mcp_ids?: string[] }[]>([]);
  const [expertId, setExpertId] = useState("");

  const refresh = async () => {
    try {
      const r = await api.tasks.list(q ? `?q=${encodeURIComponent(q)}` : "");
      setTasks(r.tasks);
    } catch (e: any) { setErr(e.message); }
  };

  useEffect(() => { refresh(); }, [q]);

  // deep link from the Experts page: #/tasks?expert=<id>
  useEffect(() => {
    const qIdx = location.hash.indexOf("?");
    if (qIdx < 0) return;
    const params = new URLSearchParams(location.hash.slice(qIdx + 1));
    const ex = params.get("expert");
    if (ex) {
      setExpertId(ex);
      setCreating(true);
      history.replaceState(null, "", "#/tasks");
    }
  }, []);
  useEffect(() => {
    api.models().then((r) => {
      setModels(r.models);
      if (r.models.length) setModelKey(`${r.models[0].provider_id}/${r.models[0].model_id}`);
    }).catch(() => {});
    api.experts().then((r) => setExperts(r.experts || [])).catch(() => {});
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    const [provider, model_id] = modelKey.split("/");
    setBusy(true); setErr("");
    try {
      const r = await api.tasks.create({ title, mode, provider, model_id, first_message: message, expert_id: expertId || undefined });
      location.hash = `#/task/${r.task.id}`;
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const statusBadge = (s: string) => <span className={`badge ${s}`}>{ { pending: "待处理", running: "执行中", idle: "空闲", failed: "失败", archived: "已归档" }[s] || s }</span>;

  return (
    <div className="page">
      <div className="page-head">
        <h2>任务</h2>
        <span className="spacer" />
        <div className="search">
          <Icon name="search" size={14} />
          <input placeholder="搜索任务…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn primary" onClick={() => setCreating(!creating)}>
          <Icon name="plus" size={14} />新建任务
        </button>
      </div>

      {creating && (
        <div className="new-task card">
          <div className="new-task-head">
            <b>新建任务</b>
            <span className="spacer" />
            <button className="icon-btn" onClick={() => setCreating(false)} title="收起"><Icon name="x" size={16} /></button>
          </div>
          <div className="modes">
            {MODES.map((m) => (
              <button key={m.id} className={`mode ${mode === m.id ? "sel" : ""}`} onClick={() => setMode(m.id)}>
                <span className="mode-name"><Icon name={m.icon} size={15} />{m.name}</span>
                <span className="desc">{m.desc}</span>
              </button>
            ))}
          </div>
          {experts.length > 0 && (
            <div className="field-row">
              <label>专家</label>
              <Select value={expertId} onChange={setExpertId}
                options={[{ value: "", label: "不使用专家" }, ...experts.map((ex) => ({ value: ex.id, label: `${ex.name}（技能×${ex.skill_ids?.length || 0} MCP×${ex.mcp_ids?.length || 0}）` }))]} />
            </div>
          )}
          <div className="field-row">
            <label>模型</label>
            <Select value={modelKey} onChange={setModelKey} options={models.map((m) => ({ value: `${m.provider_id}/${m.model_id}`, label: m.display_name || `${m.provider_id}/${m.model_id}` }))} />
          </div>
          <div className="field-row">
            <label>任务描述</label>
            <textarea rows={4} placeholder="描述任务…（支持上传文件到工作区后要求处理）" value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          {err && <div className="error">{err}</div>}
          <div className="row-end">
            <button className="btn ghost" onClick={() => setCreating(false)}>取消</button>
            <button className="btn primary" disabled={busy || !message || !modelKey} onClick={create}>
              <Icon name="play" size={13} />{busy ? "创建中…" : "创建并执行"}
            </button>
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
                {!!t.expert_id && <span className="chip expert-chip" title={`专家：${t.expert_id}`}><Icon name="sparkles" size={11} />{experts.find((ex) => ex.id === t.expert_id)?.name || t.expert_id}</span>}
                <span className="chip">{t.model_id}</span>
                <span>{new Date(t.updated_at).toLocaleString()}</span>
              </div>
            </div>
            <span className="arrow"><Icon name="chevron-right" size={16} /></span>
          </div>
        ))}
      </div>
    </div>
  );
}
