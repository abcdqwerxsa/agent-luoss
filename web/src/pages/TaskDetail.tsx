import React, { useEffect, useRef, useState } from "react";
import { api, TaskInfo } from "../lib/api";
import { Icon } from "../lib/icons";
import { Markdown } from "../lib/md";

interface ToolCard { id: string; tool: string; args: string; output: string; done: boolean; error?: boolean }
interface Bubble { role: "user" | "assistant"; text: string; thinking?: string; tools: ToolCard[]; streaming?: boolean; n?: number }

const MODE_NAME: Record<string, string> = { ask: "问一问", craft: "做一做", plan: "想一想" };
const MODE_ICON: Record<string, string> = { ask: "eye", craft: "hammer", plan: "map" };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[工具调用 ${c.name}]` : "")).join("");
  }
  return "";
}

function toolIcon(name: string): string {
  if (/bash|exec|command|run/i.test(name)) return "terminal";
  if (/read|write|edit|file|glob|ls/i.test(name)) return "file-text";
  return "sparkles";
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [auto, setAuto] = useState(true);
  const [files, setFiles] = useState<Record<string, { name: string; is_dir: boolean; size: number }[]>>({});
  const [dirOpen, setDirOpen] = useState<Record<string, boolean>>({ "": true });
  const [showFiles, setShowFiles] = useState(true);
  const [usage, setUsage] = useState<{ by_model: any[]; total_tokens: number; cost_usd: number } | null>(null);
  const [ctxUse, setCtxUse] = useState<{ tokens: number; window: number } | null>(null);
  const [experts, setExperts] = useState<{ id: string; name: string }[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [flashN, setFlashN] = useState(0);
  const [curN, setCurN] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadUsage = () => api.taskUsage(taskId).then(setUsage).catch(() => {});

  useEffect(() => {
    api.tasks.get(taskId).then((r) => {
      setTask(r.task);
      const cw = r.context_window || 0; if (cw) setCtxUse({ tokens: r.context_tokens || 0, window: cw });
    }).catch(() => {});
    // first_message race: the user message event can land after the initial
    // history fetch; retry once if the thread is still blank and idle
    setTimeout(() => {
      setBubbles((prev) => {
        if (prev.length === 0) { loadHistory(); }
        return prev;
      });
    }, 3000);
    loadUsage();
    api.experts().then((r) => setExperts(r.experts || [])).catch(() => {});
    loadHistory();
    loadFiles("");
    const es = new EventSource(`/api/v1/tasks/${taskId}/events?access_token=${encodeURIComponent(api.tokenSafe())}`);
    let cur: Bubble | null = null;
    const tools = new Map<string, ToolCard>();

    const append = (b: Bubble) => setBubbles((prev) => [...prev, b]);
    const update = (fn: (b: Bubble) => Bubble) => setBubbles((prev) => prev.map((x, i) => (i === prev.length - 1 ? fn(x) : x)));

    es.onmessage = (ev) => {
      let data: any;
      try { data = JSON.parse(ev.data); } catch { return; }
      const t = data.type;
      const p = data.payload ?? {};
      if (t === "agent_start") {
        setRunning(true); setNotice("");
        cur = { role: "assistant", text: "", tools: [], streaming: true };
        append(cur);
      } else if (t === "agent_settled") {
        loadUsage();
        setRunning(false);
        cur = null;
        update((b) => ({ ...b, streaming: false }));
        refreshTask(); loadFiles("");
      } else if (t === "context_usage") {
        setCtxUse({ tokens: +p.tokens || 0, window: +p.contextWindow || 0 });
      } else if (t === "message_update") {
        const d = p.assistantMessageEvent;
        if (!d || !cur) return;
        if (d.type === "text_delta") update((b) => ({ ...b, text: b.text + d.delta }));
        else if (d.type === "thinking_delta") update((b) => ({ ...b, thinking: (b.thinking || "") + d.delta }));
      } else if (t === "tool_execution_start") {
        const card: ToolCard = { id: p.toolCallId, tool: p.toolName, args: JSON.stringify(p.args ?? {}), output: "", done: false };
        tools.set(p.toolCallId, card);
        setBubbles((prev) => {
          if (prev.length && prev[prev.length - 1].role === "assistant") {
            const cp = [...prev];
            cp[cp.length - 1] = { ...cp[cp.length - 1], tools: [...cp[cp.length - 1].tools, card] };
            return cp;
          }
          return [...prev, { role: "assistant", text: "", tools: [card], streaming: true }];
        });
      } else if (t === "tool_execution_end") {
        const text = (p.result?.content ?? []).map((c: any) => c.text ?? "").join("\n").slice(0, 4000);
        setBubbles((prev) => prev.map((b) => ({
          ...b,
          tools: b.tools.map((tc) => (tc.id === p.toolCallId ? { ...tc, output: text, done: true, error: p.isError } : tc)),
        })));
      } else if (t === "task_status") {
        setRunning(p.status === "running");
      } else if (t === "error") {
        setNotice(p.message || "发生错误");
        setRunning(false);
      } else if (t === "auto_retry_start") {
        setNotice(`模型暂时不可用，自动重试 (${p.attempt}/${p.maxAttempts})…`);
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
    return () => es.close();
  }, [taskId]);

  useEffect(() => {
    if (auto) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles, notice, auto]);

  const refreshTask = () => api.tasks.get(taskId).then((r) => {
    setTask(r.task);
    const cw = r.context_window || 0;
    if (cw) setCtxUse((c) => c ?? { tokens: r.context_tokens || 0, window: cw });
  }).catch(() => {});
  const loadHistory = async () => {
    try {
      const r = await api.tasks.history(taskId);
      // Rebuild the same structure as the live view: everything between two
      // user messages merges into ONE assistant bubble; toolCall entries in
      // assistant content become tool cards; toolResult messages fill their
      // output so history looks identical to the live stream.
      const bs: Bubble[] = [];
      let n = 0;
      let group: Bubble | null = null;
      const cards = new Map<string, ToolCard>();
      for (const m of r.messages) {
        if (m.role === "user") {
          group = null;
          cards.clear();
          bs.push({ role: "user", text: contentToText(m.content), tools: [], n: ++n });
        } else if (m.role === "assistant") {
          if (!group) {
            group = { role: "assistant", text: "", thinking: "", tools: [] };
            bs.push(group);
          }
          const parts = Array.isArray(m.content) ? m.content : [];
          for (const e of parts) {
            if (e.type === "text" && e.text) group.text += (group.text ? "\n" : "") + e.text;
            else if (e.type === "thinking") group.thinking = (group.thinking || "") + ((group.thinking || "") ? "\n" : "") + (e.thinking || "");
            else if (e.type === "toolCall") {
              const card: ToolCard = { id: e.id, tool: e.name, args: JSON.stringify(e.arguments ?? {}), output: "", done: false };
              cards.set(e.id, card);
              group.tools.push(card);
            }
          }
        } else if (m.role === "toolResult") {
          const card = m.toolCallId ? cards.get(m.toolCallId) : undefined;
          if (card) {
            card.output = (Array.isArray(m.content) ? m.content : []).map((x: any) => x.text ?? "").join("\n").slice(0, 4000);
            card.done = true;
            card.error = m.isError;
          }
        }
      }
      // any card still pending (missing result) is closed to avoid a stuck spinner
      for (const b of bs) for (const t of b.tools) t.done = true;
      setBubbles(bs);
      setCurN(n);
    } catch { /* ignore */ }
  };

  const loadFiles = async (path: string) => {
    try {
      const r = await api.files.list(path);
      setFiles((prev) => ({ ...prev, [path]: r.nodes }));
    } catch { /* ignore */ }
  };

  const userMsgs = bubbles.filter((b) => b.role === "user" && b.n) as { n: number; text: string }[];
  const jump = (n: number) => {
    if (n < 1 || n > userMsgs.length) return;
    setCurN(n);
    document.getElementById(`um-${n}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashN(n);
    setTimeout(() => setFlashN(0), 1200);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "ArrowUp") { e.preventDefault(); jump(curN - 1); }
      if (e.key === "ArrowDown") { e.preventDefault(); jump(curN + 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const send = async (behavior?: string) => {
    if (!input.trim()) return;
    const msg = input;
    setInput("");
    setBubbles((prev) => {
      const n = (prev.filter((b) => b.role === "user").at(-1)?.n ?? 0) + 1;
      setCurN(n);
      return [...prev, { role: "user", text: msg, tools: [], n }];
    });
    try {
      await api.tasks.send(taskId, msg, behavior);
      setRunning(true);
    } catch (e: any) {
      setNotice(e.message);
      setBubbles((prev) => [...prev, { role: "assistant", text: `发送失败：${e.message}`, tools: [] }]);
    }
  };

  const abort = async () => {
    try { await api.tasks.abort(taskId); } catch (e: any) { setNotice(e.message); }
  };

  const uploadFile = async (f: File) => {
    try {
      await api.files.upload(`uploads/${f.name}`, f);
      loadFiles("");
      setNotice(`已上传 ${f.name} 到 uploads/`);
    } catch (e: any) { setNotice(e.message); }
  };

  const download = async (path: string) => {
    try {
      const blob = await api.files.download(path);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = path.split("/").pop() || "file";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) { setNotice(e.message); }
  };

  const statusBadge = task && (
    <span className={`badge ${task.status}`}>
      { { pending: "待处理", running: "执行中", idle: "空闲", failed: "失败", archived: "已归档" }[task.status] || task.status }
    </span>
  );

  const fileTree = (path: string, depth: number): React.ReactNode => {
    // dirs first, then files; natural name order (file2 < file10)
    const nodes = [...(files[path] || [])].sort((a, b) =>
      a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true }));
    return nodes.map((n) => {
      const full = path ? `${path}/${n.name}` : n.name;
      if (n.is_dir) {
        return (
          <div key={full}>
            <div className="fnode dir" style={{ paddingLeft: depth * 14 }} onClick={() => {
              const open = !dirOpen[full];
              setDirOpen((p) => ({ ...p, [full]: open }));
              if (open && !files[full]) loadFiles(full);
            }}>
              <Icon name={dirOpen[full] ? "chevron-down" : "chevron-right"} size={12} />
              <Icon name="folder" size={13} />
              {n.name}
            </div>
            {dirOpen[full] && fileTree(full, depth + 1)}
          </div>
        );
      }
      return (
        <div key={full} className="fnode" style={{ paddingLeft: depth * 14 + 24 }} onClick={() => download(full)} title="点击下载">
          <Icon name="file-text" size={13} />
          {n.name} <span className="fsize">{n.size}B</span>
        </div>
      );
    });
  };

  return (
    <div className="detail">
      <div className={`chat ${showFiles ? "" : "wide"}`} ref={scrollRef} onScroll={(e) => {
        const el = e.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (atBottom !== auto) setAuto(atBottom);
      }}>
        <div className="detail-head">
          <a href="#/tasks" className="back" title="返回任务列表"><Icon name="arrow-left" size={18} /></a>
          <h3>{task?.title || "任务"}</h3>
          {statusBadge}
          {task && <span className="chip">{task.mode} · {task.model_id}</span>}
          {task?.expert_id ? <span className="chip expert-chip" title={`专家：${task.expert_id}`}><Icon name="sparkles" size={11} />{experts.find((e) => e.id === task.expert_id)?.name || task.expert_id}</span> : null}
          {usage && usage.total_tokens > 0 && (
            <span className="chip mono" title={usage.by_model.map((m) => `${m.provider}/${m.model_id}: in ${+m.input_tokens || 0} out ${+m.output_tokens || 0} cache ${+m.cache_read_tokens || 0}/${+m.cache_write_tokens || 0} ($${(+m.cost_usd || 0).toFixed(6)})`).join("\n")}>
              {usage.total_tokens.toLocaleString()} tok · ${(+usage.cost_usd || 0).toFixed(4)}
            </span>
          )}
          {ctxUse && ctxUse.window > 0 && (() => {
            const pct = Math.min(100, Math.round((ctxUse.tokens / ctxUse.window) * 100));
            const lvl = pct >= 85 ? "danger" : pct >= 60 ? "warn" : "ok";
            return (
              <span className={`ctx-chip ${lvl}`} title={`当前上下文占用 ${ctxUse.tokens.toLocaleString()} / ${ctxUse.window.toLocaleString()} tokens（${pct}%）`}>
                <span className="ctx-label">上下文</span>
                <span className="ctx-bar"><span className="ctx-fill" style={{ width: `${pct}%` }} /></span>
                <span className="mono">{pct}%</span>
              </span>
            );
          })()}
          <span className="spacer" />
          <div className="msg-nav">
            <button className="icon-btn" onClick={() => jump(curN - 1)} title="上一条指令 (Alt+↑)" disabled={curN <= 1}><Icon name="chevron-right" size={15} className="rot270" /></button>
            <button className="icon-btn" onClick={() => jump(curN + 1)} title="下一条指令 (Alt+↓)" disabled={!userMsgs.length || curN >= userMsgs.length}><Icon name="chevron-right" size={15} className="rot90" /></button>
            <button className="icon-btn" onClick={() => setNavOpen(!navOpen)} title="指令定位"><Icon name="search" size={15} /></button>
            {navOpen && (
              <div className="msg-nav-pop">
                <div className="mnp-head">指令列表（{userMsgs.length} 条）</div>
                <div className="mnp-list">
                  {[...userMsgs].reverse().map((u) => (
                    <div key={u.n} className={`mnp-item ${u.n === curN ? "sel" : ""}`} onClick={() => { jump(u.n); setNavOpen(false); }}>
                      <span className="mono mnp-n">#{u.n}</span>
                      <span className="mnp-text">{u.text.slice(0, 60) || "(空)"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => setShowFiles(!showFiles)} title={showFiles ? "隐藏产物面板" : "显示产物面板"}>
            <Icon name="panel-right" size={15} />
          </button>
        </div>

        {notice && <div className="notice"><Icon name="triangle-alert" size={14} />{notice}</div>}

        <div className="bubbles">
          {bubbles.length === 0 && !running && (
            <div className="chat-empty">
              <Icon name="sparkles" size={22} />
              <b>{task?.expert_id ? "专家已就绪" : "任务已就绪"}</b>
              <span>{task?.expert_id ? "技能与工具已加载，输入你的需求开始" : "在下方输入消息开始任务"}</span>
            </div>
          )}
          {bubbles.map((b, i) => (
            <div key={i} id={b.n ? `um-${b.n}` : undefined} className={`bubble ${b.role} ${b.n && b.n === flashN ? "flash" : ""}`}>
              {b.role === "user" && b.n && <span className="msg-ord mono">#{b.n}</span>}
              {b.role === "assistant" && b.thinking && (
                <details className="thinking">
                  <summary><Icon name="lightbulb" size={13} />思考过程<Icon name="chevron-down" size={12} /></summary>
                  <div>{b.thinking}</div>
                </details>
              )}
              {b.tools.map((t) => (
                <details key={t.id} className={`toolcard ${t.error ? "err" : ""}`}>
                  <summary>
                    <span className="toolname"><Icon name={toolIcon(t.tool)} size={13} />{t.tool}</span>
                    <span className="toolargs-preview">{t.args}</span>
                    <span className={`toolstate ${!t.done ? "run" : t.error ? "err" : "ok"}`}>
                      {!t.done ? "运行中…" : t.error ? "失败" : "完成"}
                    </span>
                  </summary>
                  <pre className="toolargs">{t.args}</pre>
                  {t.output && <pre className="toolout">{t.output}</pre>}
                </details>
              ))}
              {b.text ? <Markdown text={b.text} /> : b.streaming ? <span className="cursor" /> : null}
            </div>
          ))}
          {bubbles.length === 0 && <div className="empty">发送第一条消息开始任务</div>}
        </div>

        <div className="composer">
          <div className="composer-box">
            <textarea
              rows={2}
              placeholder={running ? "任务执行中… 可追问修正方向（回车发送，Shift+Enter 换行）" : "输入任务或问题…（回车发送，Shift+Enter 换行）"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(running ? "follow_up" : undefined); }
              }}
            />
            <div className="composer-toolbar">
              <div className="ct-left">
                <label className="ct-btn" title="上传文件到工作区">
                  <Icon name="plus" size={15} />
                  <input type="file" hidden onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} />
                </label>
                {task && (
                  <span className="ct-pill" title="执行模式（创建任务时确定）">
                    <Icon name={MODE_ICON[task.mode] || "sparkles"} size={13} className="accent" />
                    {MODE_NAME[task.mode] || task.mode}
                  </span>
                )}
                {task && (
                  <span className="ct-pill mono" title="模型">
                    <Icon name="sparkles" size={12} className="info" />
                    {task.model_id}
                  </span>
                )}
              </div>
              <div className="ct-right">
                <button
                  className={`ct-auto ${auto ? "on" : ""}`}
                  onClick={() => { setAuto(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }}
                  title="自动滚动到最新消息"
                >
                  <Icon name="zap" size={13} />Auto
                </button>
                {running ? (
                  <>
                    <button className="ct-send stop" onClick={abort} title="中止任务"><Icon name="square" size={12} /></button>
                    <button className="btn ghost sm" onClick={() => send("follow_up")} disabled={!input.trim()}>排队追问</button>
                  </>
                ) : (
                  <button className="ct-send" onClick={() => send()} disabled={!input.trim()} title="发送"><Icon name="arrow-up" size={16} /></button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showFiles && (
        <div className="files">
          <div className="files-head">
            <Icon name="folder" size={15} />
            <h4>工作区文件</h4>
            <button className="icon-btn" onClick={() => loadFiles("")} title="刷新"><Icon name="refresh-cw" size={13} /></button>
            <button className="icon-btn" onClick={() => setShowFiles(false)} title="收起面板"><Icon name="x" size={13} /></button>
          </div>
          <div className="ftree">{fileTree("", 0)}</div>
          <p className="hint">点击文件下载，点击目录展开</p>
        </div>
      )}
    </div>
  );
}
