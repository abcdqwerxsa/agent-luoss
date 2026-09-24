import React, { useEffect, useState, useRef } from "react";
import { api, auth, KbInfo, KbDoc, KbHit, Scope } from "../lib/api";
import { Icon } from "../lib/icons";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Knowledge() {
  const [kbs, setKbs] = useState<KbInfo[]>([]);
  const [activeKbId, setActiveKbId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"docs" | "search">("docs");
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  // 检索测试
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<KbHit[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  // 管理员新建库
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createScopeType, setCreateScopeType] = useState("all");
  const [createScopeVal, setCreateScopeVal] = useState("");
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadKbs = async () => {
    try {
      const res = await api.kb.list();
      const list = res.kbs || [];
      setKbs(list);
      if (list.length > 0 && (!activeKbId || !list.some((k) => k.id === activeKbId))) {
        setActiveKbId(list[0].id);
      }
    } catch (e: any) {
      setErr(e.message || "加载知识库失败");
    }
  };

  const loadDocs = async (kbId: string) => {
    if (!kbId) return;
    setLoadingDocs(true);
    try {
      const res = await api.kb.docs(kbId);
      setDocs(res.docs || []);
    } catch (e: any) {
      setErr(e.message || "获取文档列表失败");
    } finally {
      setLoadingDocs(false);
    }
  };

  useEffect(() => {
    loadKbs();
    if (auth.user?.role === "admin") {
      api.admin.departments().then((r) => setDepts(r.departments || [])).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (activeKbId) {
      loadDocs(activeKbId);
      setHits([]);
      setHasSearched(false);
    }
  }, [activeKbId]);

  // 定时自动刷新解析进度
  useEffect(() => {
    if (!activeKbId) return;
    const timer = setInterval(() => {
      api.kb.docs(activeKbId).then((res) => {
        setDocs(res.docs || []);
      }).catch(() => {});
    }, 8000);
    return () => clearInterval(timer);
  }, [activeKbId]);

  const activeKb = kbs.find((k) => k.id === activeKbId);

  const handleUpload = async (files: FileList | null) => {
    if (!files || !files.length || !activeKbId) return;
    setUploading(true);
    setMsg("");
    setErr("");
    let successCount = 0;
    try {
      for (const f of Array.from(files)) {
        await api.kb.uploadDoc(activeKbId, f);
        successCount++;
      }
      setMsg(`成功上传 ${successCount} 个文档，后台正在切块入库…`);
      loadDocs(activeKbId);
      loadKbs();
    } catch (e: any) {
      setErr(e.message || "文档上传失败");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDeleteDoc = async (doc: KbDoc) => {
    if (!confirm(`确认删除文档「${doc.filename}」？对应分块和向量索引将被清理。`)) return;
    try {
      await api.kb.deleteDoc(doc.id);
      setMsg(`文档「${doc.filename}」已删除`);
      loadDocs(activeKbId);
      loadKbs();
    } catch (e: any) {
      setErr(e.message || "删除失败");
    }
  };

  const handleSearch = async () => {
    if (!query.trim() || !activeKbId) return;
    setSearching(true);
    setErr("");
    try {
      const res = await api.kb.search(activeKbId, query.trim(), topK);
      setHits(res.hits || []);
      setHasSearched(true);
    } catch (e: any) {
      setErr(e.message || "检索测试失败");
    } finally {
      setSearching(false);
    }
  };

  const handleCreateKb = async () => {
    if (!createName.trim()) return;
    try {
      await api.admin.createKb(createName.trim(), {
        type: createScopeType,
        value: createScopeVal,
      });
      setMsg(`知识库「${createName}」已创建`);
      setCreateName("");
      setShowCreate(false);
      loadKbs();
    } catch (e: any) {
      setErr(e.message || "创建失败");
    }
  };

  const scopeLabel = (scope: Scope) => {
    if (scope.type === "all") return "全员可见";
    if (scope.type === "department") {
      const d = depts.find((x) => x.id === scope.value);
      return `部门: ${d?.name || scope.value}`;
    }
    return `角色: ${scope.value}`;
  };

  return (
    <div className="page kb-page">
      <div className="page-head">
        <div>
          <h2>知识库</h2>
          <p className="page-sub">部门知识资产沉淀与语义检索库，自动作为 MCP 工具注入 Agent 对话</p>
        </div>
        {auth.user?.role === "admin" && (
          <button className="btn primary" onClick={() => setShowCreate(!showCreate)}>
            <Icon name="plus" size={14} /> 新建知识库
          </button>
        )}
      </div>

      {msg && <div className="notice" style={{ marginBottom: 14 }}><Icon name="info" size={14} />{msg}</div>}
      {err && <div className="notice danger" style={{ marginBottom: 14 }}><Icon name="triangle-alert" size={14} />{err}</div>}

      {/* 管理员新建知识库面板 */}
      {showCreate && (
        <div className="panel-card kb-create-panel" style={{ animation: "fade-down 180ms ease-out" }}>
          <h4><Icon name="book" size={15} /> 新建知识库</h4>
          <div className="inline-form" style={{ marginTop: 10 }}>
            <input
              placeholder="知识库名称（如：财务报销制度）"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
            <select
              value={createScopeType}
              onChange={(e) => {
                setCreateScopeType(e.target.value);
                setCreateScopeVal("");
              }}
            >
              <option value="all">全员可见</option>
              <option value="department">指定部门</option>
              <option value="role">指定角色</option>
            </select>
            {createScopeType === "department" && (
              <select value={createScopeVal} onChange={(e) => setCreateScopeVal(e.target.value)}>
                <option value="">选择部门…</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
            {createScopeType === "role" && (
              <input
                placeholder="角色（如 admin/member）"
                value={createScopeVal}
                onChange={(e) => setCreateScopeVal(e.target.value)}
              />
            )}
            <button
              className="btn primary"
              disabled={!createName.trim() || (createScopeType !== "all" && !createScopeVal)}
              onClick={handleCreateKb}
            >
              确定创建
            </button>
            <button className="btn ghost" onClick={() => setShowCreate(false)}>取消</button>
          </div>
        </div>
      )}

      <div className="kb-container">
        {/* 左侧栏：知识库列表 */}
        <div className="kb-sidebar">
          <div className="kb-sidebar-head">
            <span className="kb-sidebar-title">我的知识库</span>
            <span className="chip mono">{kbs.length}</span>
          </div>

          <div className="kb-list">
            {kbs.map((k) => {
              const active = k.id === activeKbId;
              return (
                <div
                  key={k.id}
                  className={`kb-nav-card ${active ? "active" : ""}`}
                  onClick={() => setActiveKbId(k.id)}
                >
                  <div className="kn-head">
                    <span className="kn-icon"><Icon name="book" size={16} /></span>
                    <span className="kn-name">{k.name}</span>
                  </div>
                  <div className="kn-meta">
                    <span className="kn-scope">{scopeLabel(k.scope)}</span>
                    <span className="kn-count mono">{k.doc_count || 0} 篇</span>
                  </div>
                </div>
              );
            })}
            {!kbs.length && (
              <div className="empty" style={{ padding: "30px 10px" }}>
                暂无可见知识库{auth.user?.role === "admin" ? "，请点击上方新建" : ""}
              </div>
            )}
          </div>
        </div>

        {/* 右侧主体工作台 */}
        <div className="kb-main">
          {activeKb ? (
            <>
              {/* 知识库详情 Header */}
              <div className="kb-detail-head">
                <div className="kdh-info">
                  <div className="kdh-title-row">
                    <h3>{activeKb.name}</h3>
                    <span className="chip">{scopeLabel(activeKb.scope)}</span>
                    <span className="chip mono">文档 ×{docs.length}</span>
                  </div>
                  <div className="kdh-sub mono">MCP: {activeKb.mcp_entry_id || `kb-${activeKb.id}`}</div>
                </div>

                <div className="kdh-tabs">
                  <button
                    type="button"
                    className={`kdh-tab-btn ${activeTab === "docs" ? "on" : ""}`}
                    onClick={() => setActiveTab("docs")}
                  >
                    <Icon name="file-text" size={14} /> 文档管理
                  </button>
                  <button
                    type="button"
                    className={`kdh-tab-btn ${activeTab === "search" ? "on" : ""}`}
                    onClick={() => setActiveTab("search")}
                  >
                    <Icon name="search" size={14} /> 语义检索测试
                  </button>
                </div>
              </div>

              {/* TAB 1: 文档管理与上传 */}
              {activeTab === "docs" && (
                <div className="kb-docs-section">
                  {/* 拖拽上传区 */}
                  <div
                    className="kb-dropzone"
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (e.dataTransfer.files) handleUpload(e.dataTransfer.files);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => handleUpload(e.target.files)}
                    />
                    <div className="kdz-icon">
                      <Icon name="upload" size={26} />
                    </div>
                    <div className="kdz-title">
                      {uploading ? "正在上传文档并触发分块解析…" : "点击或拖拽文件到此处上传"}
                    </div>
                    <div className="kdz-desc">
                      支持 PDF、Word (.docx)、Markdown (.md)、TXT、CSV、Excel (.xlsx)，单文件最大 50MB
                    </div>
                  </div>

                  {/* 文档清单 */}
                  <div className="kb-table-wrap card">
                    <div className="ktw-head">
                      <h4>文档列表（{docs.length}）</h4>
                      <button className="icon-btn" onClick={() => loadDocs(activeKbId)} data-tip="刷新文档列表">
                        <Icon name="refresh-cw" size={13} />
                      </button>
                    </div>

                    <table className="kb-docs-table">
                      <thead>
                        <tr>
                          <th>文档名称</th>
                          <th style={{ width: 90 }}>大小</th>
                          <th style={{ width: 100 }}>上传人</th>
                          <th style={{ width: 120 }}>更新时间</th>
                          <th style={{ width: 110 }}>解析状态</th>
                          <th style={{ width: 70, textAlign: "right" }}>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {docs.map((doc) => {
                          const isReady = doc.status === "ready";
                          const isParsing = doc.status === "parsing" || doc.status === "pending";
                          const isErr = doc.status === "error" || doc.status === "failed";

                          return (
                            <tr key={doc.id}>
                              <td>
                                <div className="kdt-file-cell">
                                  <Icon name="file-text" size={14} className="kdt-file-icon" />
                                  <span className="kdt-filename" title={doc.filename}>{doc.filename}</span>
                                </div>
                              </td>
                              <td className="mono text-muted">{formatBytes(doc.size)}</td>
                              <td className="text-muted">{doc.uploader || "-"}</td>
                              <td className="mono text-muted">{formatDate(doc.updated_at)}</td>
                              <td>
                                {isReady && (
                                  <span className="status-chip ok">
                                    <span className="status-dot ok" /> 已就绪
                                  </span>
                                )}
                                {isParsing && (
                                  <span className="status-chip warn">
                                    <span className="status-dot spin" /> 解析中…
                                  </span>
                                )}
                                {isErr && (
                                  <span className="status-chip err" title={doc.error || "解析失败"}>
                                    <span className="status-dot err" /> 异常
                                  </span>
                                )}
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <button
                                  className="icon-btn danger"
                                  onClick={() => handleDeleteDoc(doc)}
                                  data-tip="删除此文档"
                                >
                                  <Icon name="trash" size={13} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {!docs.length && !loadingDocs && (
                          <tr>
                            <td colSpan={6} style={{ textAlign: "center", padding: "40px 0", color: "var(--text-3)" }}>
                              暂无文档，请在上方上传文档
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* TAB 2: 语义检索测试 */}
              {activeTab === "search" && (
                <div className="kb-search-section card">
                  <div className="kss-head">
                    <div>
                      <h4>语义检索测试 (Playground)</h4>
                      <p className="kss-sub">输入自然语言问题，模拟 Agent 调用 MCP 工具召回的知识切块与打分</p>
                    </div>
                  </div>

                  <div className="kss-form">
                    <div className="kss-input-wrap">
                      <input
                        placeholder="输入问题或检索词，如：差旅报销餐费标准是多少？"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                      />
                      <button
                        className="btn primary"
                        disabled={!query.trim() || searching}
                        onClick={handleSearch}
                      >
                        <Icon name="search" size={14} />
                        {searching ? "检索中…" : "检索"}
                      </button>
                    </div>
                    <div className="kss-opts">
                      <span className="text-muted">Top-K:</span>
                      {[3, 5, 10].map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={`chip ${topK === k ? "chip-on" : ""}`}
                          onClick={() => setTopK(k)}
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 检索结果列表 */}
                  <div className="kss-results">
                    {hits.map((hit, i) => (
                      <div key={i} className="kb-hit-card">
                        <div className="khc-head">
                          <span className="khc-rank mono">#{i + 1}</span>
                          <span className="khc-title">
                            <Icon name="file-text" size={13} />
                            <b>{hit.title || "未知文档"}</b>
                            {hit.section && <span className="khc-section">/ {hit.section}</span>}
                          </span>
                          <span className="khc-score mono" data-tip="相似度相关得分">
                            Score: {(hit.score || 0).toFixed(4)}
                          </span>
                        </div>
                        <div className="khc-snippet">
                          {hit.snippet}
                        </div>
                      </div>
                    ))}
                    {hasSearched && !hits.length && !searching && (
                      <div className="empty" style={{ padding: "40px 0" }}>
                        未检索到相关内容，请尝试更换关键词
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty" style={{ padding: "80px 0" }}>
              请在左侧选择或新建一个知识库
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
