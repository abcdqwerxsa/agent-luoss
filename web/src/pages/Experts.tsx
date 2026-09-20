import React, { useEffect, useState } from "react";
import { api, auth } from "../lib/api";
import { Icon } from "../lib/icons";

interface Expert { id: string; name: string; description: string; skill_ids?: string[]; mcp_ids?: string[] }

export function Experts() {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [err, setErr] = useState("");
  const [used, setUsed] = useState<Record<string, "go">>({});

  useEffect(() => {
    api.experts().then((r) => setExperts(r.experts || [])).catch((e) => setErr(e.message));
  }, []);

  const use = (ex: Expert) => {
    setUsed((u) => ({ ...u, [ex.id]: "go" }));
    location.hash = `#/tasks?expert=${encodeURIComponent(ex.id)}`;
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

      <div className="expert-plaza">
        {experts.map((ex) => (
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
            <button className="btn primary eb-use" disabled={used[ex.id] === "go"} onClick={() => use(ex)}>
              <Icon name="play" size={13} />{used[ex.id] === "go" ? "正在跳转…" : "开始任务"}
            </button>
          </div>
        ))}
        {!experts.length && !err && (
          <div className="empty">暂无可用专家{auth.user?.role === "admin" ? "，去 管理后台 → 专家 添加" : ""}</div>
        )}
      </div>
    </div>
  );
}
