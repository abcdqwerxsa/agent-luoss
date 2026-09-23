import React, { useEffect, useState } from "react";
import { api, auth, ModelOpt, KbInfo } from "../lib/api";
import { Icon } from "../lib/icons";

interface Expert { id: string; name: string; description: string; skill_ids?: string[]; mcp_ids?: string[] }

export function Experts() {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState("");
  const [cat, setCat] = useState("全部");
  const [kbs, setKbs] = useState<KbInfo[]>([]);
  const [kbMsg, setKbMsg] = useState("");

  const uploadDoc = async (kbId: string, files: FileList | null) => {
    if (!files?.length) return;
    setKbMsg("");
    let ok = 0;
    for (const f of Array.from(files)) {
      try { await api.uploadMyKbDoc(kbId, f); ok++; } catch (e: any) { setKbMsg(`${f.name}: ${e.message}`); }
    }
    if (ok) setKbMsg(`已上传 ${ok} 个文档到知识库，解析后即可在对话中检索`);
  };

  // category = name prefix before「·」(import-catalog convention); uncategorized → 其他
  const catOf = (name: string) => (name.includes("·") ? name.split("·")[0] : "其他");
  const cats = ["全部", ...Array.from(new Set(experts.map((e) => catOf(e.name))))];
  const shown = cat === "全部" ? experts : experts.filter((e) => catOf(e.name) === cat);

  useEffect(() => {
    api.experts().then((r) => setExperts(r.experts || [])).catch((e) => setErr(e.message));
    api.models().then((r) => setModels(r.models || [])).catch(() => {});
    api.myKbs().then((r) => setKbs(r.kbs || [])).catch(() => {});
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

      {!!kbs.length && (
        <div className="panel-card" style={{ marginBottom: 16 }}>
          <h4><Icon name="book" size={14} />部门知识库</h4>
          <div className="hint" style={{ marginBottom: 8 }}>新建任务时会自动携带以下知识库的检索工具；部门成员可上传文档</div>
          <div className="inline-form" style={{ flexWrap: "wrap" }}>
            {kbs.map((k) => (
              <React.Fragment key={k.id}>
                <span className="chip"><Icon name="book" size={11} />{k.name} · {k.doc_count} 篇</span>
                <button className="btn small" onClick={() => (document.getElementById(`mykbfile-${k.id}`) as HTMLInputElement)?.click()}><Icon name="upload" size={12} />上传</button>
                <input id={`mykbfile-${k.id}`} type="file" multiple hidden onChange={(e) => { uploadDoc(k.id, e.target.files); e.target.value = ""; }} />
              </React.Fragment>
            ))}
          </div>
          {kbMsg && <div className="msg">{kbMsg}</div>}
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
