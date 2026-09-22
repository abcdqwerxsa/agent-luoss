import React, { useEffect, useState } from "react";
import { api, auth, ModelOpt } from "../lib/api";
import { Icon } from "../lib/icons";

interface Expert { id: string; name: string; description: string; skill_ids?: string[]; mcp_ids?: string[] }

export function Experts() {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");
  const [cat, setCat] = useState("全部");

  // category = name prefix before「·」(import-catalog convention); uncategorized → 其他
  const catOf = (name: string) => (name.includes("·") ? name.split("·")[0] : "其他");
  const cats = ["全部", ...Array.from(new Set(experts.map((e) => catOf(e.name))))];
  const shown = cat === "全部" ? experts : experts.filter((e) => catOf(e.name) === cat);

  useEffect(() => {
    api.experts().then((r) => setExperts(r.experts || [])).catch((e) => setErr(e.message));
    api.models().then((r) => setModels(r.models || [])).catch(() => {});
  }, []);

  // Start an empty task bound to the expert: skills/MCP are loaded into the
  // session, the conversation UI opens and the user sends the first message
  // themselves — same interaction as a normal task, just pre-equipped.
  const start = async (ex: Expert) => {
    if (!models.length) { setErr("暂无可用模型，请联系管理员配置"); return; }
    setBusyId(ex.id); setErr("");
    try {
      const m = models[0];
      const r = await api.tasks.create({
        title: `${ex.name} · ${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
        mode: "craft",
        provider: m.provider_id, model_id: m.model_id,
        first_message: "", expert_id: ex.id,
      });
      location.hash = `#/task/${r.task.id}`;
    } catch (e: any) { setErr(e.message); setBusyId(""); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>专家</h2>
          <p className="page-sub">预装技能与工具组合的领域专家，一键开任务</p>
        </div>
      </div>

      {err && <div className="error">{err}</div>}

      {cats.length > 2 && (
        <div className="expert-cats">
          {cats.map((c) => (
            <button key={c} type="button" className={`chip cat-chip ${cat === c ? "chip-on" : ""}`} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
      )}

      <div className="expert-plaza">
        {shown.map((ex) => (
          <div key={ex.id} className="expert-big card">
            <div className="eb-head">
              <span className="eb-icon"><Icon name="sparkles" size={20} /></span>
              <div className="eb-title">
                <b>{ex.name}</b>
                <span className="mono eb-id">{ex.id}</span>
              </div>
            </div>
            <p className="eb-desc">{ex.description}</p>
            <div className="eb-meta">
              <span className="chip"><Icon name="sparkles" size={11} />技能 ×{ex.skill_ids?.length || 0}</span>
              <span className="chip"><Icon name="plug" size={11} />MCP ×{ex.mcp_ids?.length || 0}</span>
            </div>
            <button className="btn primary eb-use" disabled={busyId === ex.id} onClick={() => start(ex)}>
              <Icon name="play" size={13} />{busyId === ex.id ? "创建中…" : "开始对话"}
            </button>
          </div>
        ))}
        {!experts.length && !err && (
          <div className="empty">暂无可用专家{auth.user?.role === "admin" ? "，去 管理后台 → 专家 添加" : ""}</div>
        )}
        {!!experts.length && !shown.length && <div className="empty">该类别暂无专家</div>}
      </div>
    </div>
  );
}
