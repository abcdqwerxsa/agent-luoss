import React, { useEffect, useRef, useState } from "react";
import { api, TaskInfo, ModelOpt } from "../lib/api";
import { Icon } from "../lib/icons";
import { Markdown } from "../lib/md";
import { Select } from "../lib/select";
import Loader from "../components/Loader";
import ThinkingTrace from "../components/ThinkingTrace";
import DiffView from "../components/DiffView";
import PlanApproval from "../components/PlanApproval";
import { ErrorBoundary } from "../components/ErrorBoundary";

interface ToolCard { id: string; tool: string; args: string; output: string; done: boolean; error?: boolean }
interface Bubble { role: "user" | "assistant"; text: string; thinking?: string; tools: ToolCard[]; streaming?: boolean; n?: number; error?: string }

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

function extractToolParam(tool: string, argsStr: string): string {
  try {
    const args = JSON.parse(argsStr);
    if (!args || typeof args !== "object") return "";
    if (args.path) return String(args.path).split("/").pop() || args.path;
    if (args.TargetFile) return String(args.TargetFile).split("/").pop() || args.TargetFile;
    if (args.filePath) return String(args.filePath).split("/").pop() || args.filePath;
    if (args.filename) return String(args.filename).split("/").pop() || args.filename;
    if (args.command) return String(args.command).slice(0, 32);
    if (args.CommandLine) return String(args.CommandLine).slice(0, 32);
    if (args.query) return String(args.query).slice(0, 24);
    if (args.Query) return String(args.Query).slice(0, 24);
    if (args.url) return String(args.url).slice(0, 24);
    if (args.Url) return String(args.Url).slice(0, 24);
    const firstVal = Object.values(args)[0];
    if (typeof firstVal === "string") return firstVal.slice(0, 24);
  } catch { /* ignore */ }
  return "";
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [models, setModels] = useState<ModelOpt[]>([]);
  const [modelKey, setModelKey] = useState(""); // "" = keep current, "auto", or provider/model_id
  const [modeKey, setModeKey] = useState("");   // "" = keep current, or ask|craft|plan
  const [planPromptAt, setPlanPromptAt] = useState(-1); // bubbles count when the plan approval was last shown
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
  const userScrollingRef = useRef(false);
  const scrollTimerRef = useRef<any>(null);
  const isProgrammaticScrollRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);

  const loadUsage = () => api.taskUsage(taskId).then(setUsage).catch(() => {});
  const histSeqRef = useRef(0); // last rendered history seq — SSE reattach anchor

  useEffect(() => {
    let cancelled = false;
    api.tasks.get(taskId).then((r) => {
      setTask(r.task);
      if (r.task?.status && r.task.status !== "running" && r.task.status !== "pending") {
        setRunning(false);
      }
      const cw = r.context_window || 0; if (cw) setCtxUse({ tokens: r.context_tokens || 0, window: cw });
    }).catch(() => {});
    loadUsage();
    api.experts().then((r) => setExperts(r.experts || [])).catch(() => {});
    loadFiles("");

    let cur: Bubble | null = null;
    let lastSeq = 0; // replay dedup: reconnects re-deliver events after Last-Event-ID
    const tools = new Map<string, ToolCard>();

    const append = (b: Bubble) => {
      if (!b || !b.role) return;
      setBubbles((prev) => [...prev.filter((x): x is Bubble => Boolean(x && x.role)), b]);
    };
    const update = (fn: (b: Bubble) => Bubble) =>
      setBubbles((prev) => {
        const valid = prev.filter((x): x is Bubble => Boolean(x && x.role));
        if (valid.length === 0) return valid;
        return valid.map((x, i, arr) => (i === arr.length - 1 ? fn(x) : x));
      });
    const ensureStreamingBubble = () => {
      const bubble: Bubble = { role: "assistant", text: "", tools: [], streaming: true };
      cur = bubble;
      setBubbles((prev) => {
        const valid = prev.filter((b): b is Bubble => Boolean(b && b.role));
        const last = valid[valid.length - 1];
        if (last && last.role === "assistant" && last.streaming) {
          cur = last;
          return valid;
        }
        return [...valid, bubble];
      });
    };

    const startStream = () => {
      if (cancelled) return;
      const es = new EventSource(`/api/v1/tasks/${taskId}/events?access_token=${encodeURIComponent(api.tokenSafe())}&since=${histSeqRef.current}`);
      es.onmessage = (ev) => {
        let data: any;
        try { data = JSON.parse(ev.data); } catch { return; }
        const seq = +data.seq || 0;
        if (seq && seq <= lastSeq) return; // duplicate from replay
        if (seq) lastSeq = seq;
        const t = data.type;
        const p = data.payload ?? {};
        if (t === "agent_start") {
          setRunning(true); setNotice("");
          // idempotent: auto-retry re-emits agent_start MID-TURN — the trailing
          // streaming bubble may already hold tool cards/text; reuse it instead
          // of stacking a fresh empty one (stacked pills never cleared)
          ensureStreamingBubble();
        } else if (t === "agent_settled") {
          loadUsage();
          setRunning(false);
          cur = null;
          // close EVERY streaming bubble — retries/reconnects may have left
          // stacked ones; only the last would otherwise clear its spinner
          setBubbles((prev) =>
            prev
              .filter((b): b is Bubble => Boolean(b && b.role))
              .map((b) => (b.streaming ? { ...b, streaming: false } : b))
          );
          refreshTask(); loadFiles("");
        } else if (t === "context_usage") {
          setCtxUse({ tokens: +p.tokens || 0, window: +p.contextWindow || 0 });
        } else if (t === "message_start") {
          // late join / replay may deliver message_start without agent_start
          if (p.message?.role === "assistant" && !cur) ensureStreamingBubble();
        } else if (t === "message_update") {
          const d = p.assistantMessageEvent;
          if (!d || !cur) return;
          if (d.type === "text_delta") update((b) => ({ ...b, text: b.text + d.delta }));
          else if (d.type === "thinking_delta") update((b) => ({ ...b, thinking: (b.thinking || "") + d.delta }));
        } else if (t === "message_end") {
          const msg = p.message ?? {};
          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            // canonical snapshot heals missed deltas (reattach, retry gaps)
            let text = "", think = "", hasTools = false;
            for (const e of msg.content) {
              if (!e) continue;
              if (e.type === "text" && e.text) text += (text ? "\n" : "") + e.text;
              else if (e.type === "thinking") think += (think ? "\n" : "") + (e.thinking || "");
              else if (e.type === "toolCall") hasTools = true;
            }
            const errMsg = msg.errorMessage || (msg.stopReason === "error" ? "模型调用异常" : "");
            cur = null;
            setBubbles((prev) => {
              const valid = prev.filter((x): x is Bubble => Boolean(x && x.role));
              return valid.map((x, i, arr) =>
                i === arr.length - 1 && x.role === "assistant"
                  ? {
                      ...x,
                      text: text || x.text,
                      thinking: think || x.thinking,
                      streaming: hasTools ? x.streaming : false,
                      error: errMsg || x.error,
                    }
                  : x
              );
            });
            if (!hasTools && (msg.stopReason === "stop" || msg.stopReason === "end_turn" || msg.stopReason === "error")) {
              setTimeout(() => refreshTask(), 300);
            }
          }
        } else if (t === "tool_execution_start") {
          const card: ToolCard = { id: p.toolCallId, tool: p.toolName, args: JSON.stringify(p.args ?? {}), output: "", done: false };
          tools.set(p.toolCallId, card);
          setBubbles((prev) => {
            const valid = prev.filter((b): b is Bubble => Boolean(b && b.role));
            const last = valid[valid.length - 1];
            if (last && last.role === "assistant") {
              const cp = [...valid];
              cp[cp.length - 1] = { ...last, tools: [...(last.tools || []), card] };
              return cp;
            }
            const newAssistant: Bubble = { role: "assistant", text: "", tools: [card], streaming: true };
            cur = newAssistant;
            return [...valid, newAssistant];
          });
        } else if (t === "tool_execution_end") {
          const text = (p.result?.content ?? []).map((c: any) => c?.text ?? "").join("\n").slice(0, 4000);
          setBubbles((prev) =>
            prev
              .filter((b): b is Bubble => Boolean(b && b.role))
              .map((b) => ({
                ...b,
                tools: (b.tools || []).map((tc) => (tc.id === p.toolCallId ? { ...tc, output: text, done: true, error: p.isError } : tc)),
              }))
          );
        } else if (t === "task_status") {
          setRunning(p.status === "running");
        } else if (t === "error") {
          const errMsg = p.message || "发生错误";
          setNotice(errMsg);
          setRunning(false);
          cur = null;
          setBubbles((prev) => {
            const valid = prev.filter((b): b is Bubble => Boolean(b && b.role));
            const last = valid[valid.length - 1];
            if (last && last.role === "assistant") {
              return valid.map((b, i, arr) => (i === arr.length - 1 ? { ...b, error: errMsg, streaming: false } : b));
            }
            return [...valid, { role: "assistant", text: "", tools: [], error: errMsg, streaming: false }];
          });
        } else if (t === "auto_retry_start") {
          const retryNotice = p.error?.message || p.message || `模型接口触发限流或暂时不可用，正在自动重试 (${p.attempt}/${p.maxAttempts})…`;
          setNotice(retryNotice);
          update((b) => ({
            ...b,
            error: b.error || retryNotice,
            streaming: true,
          }));
        }
      };
      es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
      esRef.current = es;
    };

    // history first (it sets the since anchor), then attach the live tail —
    // re-entry mid-run replays exactly the in-flight turn
    loadHistory().finally(() => startStream());
    return () => { cancelled = true; esRef.current?.close(); };
  }, [taskId]);

  useEffect(() => { api.models().then((r) => setModels(r.models)).catch(() => {}); }, []);

  // server-truth reconciliation: any frontend stuck state (missed settled,
  // replay weirdness) corrects itself when the tab regains focus
  useEffect(() => {
    const onFocus = () => refreshTask();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [taskId]);

  useEffect(() => {
    if (auto && !userScrollingRef.current) {
      isProgrammaticScrollRef.current = true;
      scrollRef.current?.scrollTo({ top: scrollRef.current?.scrollHeight });
    }
  }, [bubbles, notice, auto]);

  const refreshTask = () => api.tasks.get(taskId).then((r) => {
    setTask(r.task);
    if (r.task?.status && r.task.status !== "running" && r.task.status !== "pending") {
      setRunning(false);
    }
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
      for (const m of (r.messages || [])) {
        if (!m || !m.role) continue;
        if (m.role === "user") {
          group = null;
          cards.clear();
          bs.push({ role: "user", text: contentToText(m.content), tools: [], n: ++n });
        } else if (m.role === "assistant") {
          if (!group) {
            group = { role: "assistant", text: "", thinking: "", tools: [] };
            bs.push(group);
          }
          const errCandidate = (m as any).errorMessage || (m.isError ? "模型调用异常" : "");
          if (errCandidate) {
            group.error = errCandidate;
          }
          const parts = Array.isArray(m.content) ? m.content : [];
          for (const e of parts) {
            if (!e) continue;
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
            card.output = (Array.isArray(m.content) ? m.content : []).map((x: any) => x?.text ?? "").join("\n").slice(0, 4000);
            card.done = true;
            card.error = m.isError;
          }
        }
      }
      // any card still pending (missing result) is closed to avoid a stuck spinner
      for (const b of bs) {
        if (b?.tools) {
          for (const t of b.tools) if (t) t.done = true;
        }
      }
      setBubbles(bs.filter((b): b is Bubble => Boolean(b && b.role)));
      setCurN(n);
      histSeqRef.current = r.last_seq || 0;
    } catch { /* ignore */ }
  };

  const loadFiles = async (path: string) => {
    try {
      const r = await api.files.list(path);
      setFiles((prev) => ({ ...prev, [path]: r.nodes }));
    } catch { /* ignore */ }
  };

  const userMsgs = bubbles.filter((b): b is Bubble & { n: number; text: string } => Boolean(b && b.role === "user" && b.n));
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

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const saveTitle = () => {
    const t = titleDraft.trim();
    setRenaming(false);
    if (t && t !== task?.title) {
      api.tasks.patch(taskId, { title: t })
        .then(() => setTask((prev: any) => (prev ? { ...prev, title: t } : prev)))
        .catch((e: any) => setNotice(e.message));
    }
  };

  const delTask = () => {
    if (confirm(`删除任务「${task?.title || taskId}」？此操作不可恢复。`)) {
      api.tasks.del(taskId).then(() => { location.hash = "#/tasks"; }).catch((e: any) => setNotice(e.message));
    }
  };

  const sendText = async (msg: string, behavior?: string) => {
    setBubbles((prev) => {
      const valid = prev.filter((b): b is Bubble => Boolean(b && b.role));
      const n = (valid.filter((b) => b.role === "user").at(-1)?.n ?? 0) + 1;
      setCurN(n);
      return [...valid, { role: "user", text: msg, tools: [], n }];
    });
    try {
      const curKey = task ? `${task.provider}/${task.model_id}` : "";
      const effMode = modeKey || task?.mode;
      const effModel = modelKey || curKey;
      const model = effModel && effModel !== curKey
        ? effModel === "auto" ? { provider: "auto", model_id: "auto" }
        : (() => { const [p, m] = effModel.split("/"); return { provider: p, model_id: m }; })()
        : undefined;
      const mode = effMode && task && effMode !== task.mode ? effMode : undefined;
      if (behavior === "steer") {
        await api.tasks.steer(taskId, msg);
      } else {
        await api.tasks.send(taskId, msg, behavior, undefined, model, mode);
      }
      setRunning(true);
      setModelKey("");
      setModeKey("");
    } catch (e: any) {
      setNotice(e.message);
      setBubbles((prev) => [...prev, { role: "assistant", text: `发送失败：${e.message}`, tools: [] }]);
    }
  };

  // 任务结束后自动触发排队消息
  useEffect(() => {
    if (!running && queuedMessage) {
      const q = queuedMessage;
      setQueuedMessage(null);
      void sendText(q);
    }
  }, [running, queuedMessage]);

  const send = () => {
    if (!input.trim()) return;
    const msg = input.trim();
    setInput("");
    if (running) {
      setQueuedMessage(msg);
    } else {
      void sendText(msg);
    }
  };

  const steerQueued = async () => {
    if (!queuedMessage) return;
    const msg = queuedMessage;
    setQueuedMessage(null);
    try {
      await api.tasks.steer(taskId, msg);
    } catch (e: any) {
      setNotice(`插话失败：${e.message}`);
    }
  };

  const editQueued = () => {
    if (!queuedMessage) return;
    setInput(queuedMessage);
    setQueuedMessage(null);
  };

  // generative-UI action loop: buttons inside rendered json-ui blocks send
  // their message back into the conversation as if typed by the user.
  useEffect(() => {
    const onAction = (e: Event) => {
      const msg = (e as CustomEvent).detail?.message;
      if (typeof msg === "string" && msg.trim()) {
        const text = msg.trim();
        if (running) {
          setQueuedMessage(text);
        } else {
          void sendText(text);
        }
      }
    };
    window.addEventListener("genui:action", onAction);
    return () => window.removeEventListener("genui:action", onAction);
  }, [running]);

  const abort = async () => {
    try {
      await api.tasks.abort(taskId);
      setRunning(false);
      setBubbles((prev) => prev.map((b) => (b.streaming ? { ...b, streaming: false } : b)));
      refreshTask();
    } catch (e: any) { setNotice(e.message); }
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
        <div key={full} className="fnode" style={{ paddingLeft: depth * 14 + 24 }} onClick={() => download(full)} data-tip="点击下载">
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
        if (isProgrammaticScrollRef.current) {
          isProgrammaticScrollRef.current = false;
          return;
        }
        userScrollingRef.current = true;
        if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = setTimeout(() => {
          userScrollingRef.current = false;
        }, 300);
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (atBottom !== auto) setAuto(atBottom);
      }}>
        <div className="detail-head">
          <a href="#/tasks" className="back" data-tip-down data-tip="返回任务列表"><Icon name="arrow-left" size={18} /></a>
          {renaming ? (
            <span className="rename-row">
              <input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setRenaming(false); }} />
              <button className="icon-btn" onClick={saveTitle} data-tip-down data-tip="保存 (Enter)"><Icon name="check" size={14} /></button>
              <button className="icon-btn" onClick={() => setRenaming(false)} data-tip-down data-tip="取消 (Esc)"><Icon name="x" size={14} /></button>
            </span>
          ) : (
            <span className="title-wrap">
              <h3 onClick={() => { setTitleDraft(task?.title || ""); setRenaming(true); }}>{task?.title || "任务"}</h3>
              <button className="icon-btn" data-tip-down data-tip="重命名" onClick={() => { setTitleDraft(task?.title || ""); setRenaming(true); }}><Icon name="edit" size={13} /></button>
            </span>
          )}
          {statusBadge}
          {task?.expert_id ? <span className="chip expert-chip" data-tip-down data-tip={`专家：${task.expert_id}`}><Icon name="sparkles" size={11} />{experts.find((e) => e.id === task.expert_id)?.name || task.expert_id}</span> : null}
          {usage && usage.total_tokens > 0 && (
            <span className="chip mono" data-tip-down data-tip={usage.by_model.map((m) => `${m.provider}/${m.model_id}: in ${+m.input_tokens || 0} out ${+m.output_tokens || 0} cache ${+m.cache_read_tokens || 0}/${+m.cache_write_tokens || 0} ($${(+m.cost_usd || 0).toFixed(6)})`).join("\n")}>
              {usage.total_tokens.toLocaleString()} tok · ${(+usage.cost_usd || 0).toFixed(4)}
            </span>
          )}
          {ctxUse && ctxUse.window > 0 && (() => {
            const pct = Math.min(100, Math.round((ctxUse.tokens / ctxUse.window) * 100));
            const lvl = pct >= 85 ? "danger" : pct >= 60 ? "warn" : "ok";
            return (
              <span className={`ctx-chip ${lvl}`} data-tip-down data-tip={`当前上下文占用 ${ctxUse.tokens.toLocaleString()} / ${ctxUse.window.toLocaleString()} tokens（${pct}%）`}>
                <span className="ctx-label">上下文</span>
                <span className="ctx-bar"><span className="ctx-fill" style={{ width: `${pct}%` }} /></span>
                <span className="mono">{pct}%</span>
              </span>
            );
          })()}
          <span className="spacer" />
          <div className="msg-nav">
            <button className="icon-btn" onClick={() => jump(curN - 1)} data-tip-down data-tip="上一条指令 (Alt+↑)" disabled={curN <= 1}><Icon name="chevron-right" size={15} className="rot270" /></button>
            <button className="icon-btn" onClick={() => jump(curN + 1)} data-tip-down data-tip="下一条指令 (Alt+↓)" disabled={!userMsgs.length || curN >= userMsgs.length}><Icon name="chevron-right" size={15} className="rot90" /></button>
            <button className="icon-btn" onClick={() => setNavOpen(!navOpen)} data-tip-down data-tip="指令定位"><Icon name="search" size={15} /></button>
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
          <button className="icon-btn" onClick={() => setShowFiles(!showFiles)} data-tip-down data-tip={showFiles ? "隐藏产物面板" : "显示产物面板"}>
            <Icon name="panel-right" size={15} />
          </button>
          <button className="icon-btn danger" onClick={delTask} data-tip-down data-tip="删除任务">
            <Icon name="trash" size={15} />
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
          {bubbles.map((b, i) => {
            if (!b || !b.role) return null;
            return (
              <div key={i} id={b.n ? `um-${b.n}` : undefined} className={`bubble ${b.role} ${b.n && b.n === flashN ? "flash" : ""}`}>
                <ErrorBoundary title="气泡渲染异常" fallback={<div className="bubble-error"><Icon name="triangle-alert" size={14} /><span>气泡内容渲染失败</span></div>}>
                  {b.role === "user" && (
                    <div className="bubble-user-row">
                      {b.n && <span className="msg-ord mono">#{b.n}</span>}
                      <div className="bubble-user-text">{b.text}</div>
                    </div>
                  )}
                  {b.role === "assistant" && (
                    <>
                      {(b.thinking || (b.tools && b.tools.length > 0)) && (
                        <ThinkingTrace
                          working={!!b.streaming}
                          active="执行中"
                          done={(b.tools && b.tools.length) ? `执行了 ${b.tools.length} 步` : "思考过程"}
                          rows={(b.tools || []).map((t) => ({
                            primary: t.tool,
                            chip: extractToolParam(t.tool, t.args),
                            tool: t.tool,
                            secondary: t.error ? "失败" : t.done ? "完成" : "…",
                            mono: true,
                            detail: (
                              <div className="tool-detail-box">
                                {t.args && <pre className="toolargs">{t.args}</pre>}
                                {t.output && (t.output.match(/^[+-][^+-]/m) ? <DiffView diff={t.output} /> : <pre className="toolout">{t.output}</pre>)}
                              </div>
                            ),
                          }))}
                        >
                          {b.thinking && (
                            <div className="trace-thinking-block">
                              <div className="trace-thinking-head">
                                <Icon name="sparkles" size={12} />
                                <span>深度思考</span>
                              </div>
                              <div className="trace-thinking-body">{b.thinking}</div>
                            </div>
                          )}
                        </ThinkingTrace>
                      )}
                      {b.text ? (
                        <Markdown text={b.text} />
                      ) : b.streaming && !b.thinking && (!b.tools || b.tools.length === 0) ? (
                        <Loader label="生成中" />
                      ) : null}
                      {b.error && (
                        <div className="bubble-error">
                          <Icon name="triangle-alert" size={14} />
                          <span>{b.error.includes("429") ? `模型接口限流 (429)：${b.error}。请稍后重试或切换右下角模型。` : b.error}</span>
                        </div>
                      )}
                      {!b.text && !b.streaming && (!b.tools || !b.tools.length) && !b.thinking && !b.error && (
                        <div className="bubble-empty gui-muted">（未返回内容）</div>
                      )}
                    </>
                  )}
                </ErrorBoundary>
              </div>
            );
          })}
        </div>

        {task?.mode === "plan" && !running && bubbles.length > 0 && bubbles.filter(Boolean).at(-1)?.role === "assistant" && planPromptAt !== bubbles.length && (
          <PlanApproval
            onConfirm={() => { setPlanPromptAt(bubbles.length); void sendText("确认执行以上计划"); }}
            onRevise={() => setPlanPromptAt(bubbles.length)}
          />
        )}

        <div className="composer">
          {queuedMessage && (
            <div className="queued-strip" style={{ animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <div className="queued-strip-left">
                <span className="queued-badge">
                  <Icon name="clock" size={12} />
                  <span>已排队追问</span>
                </span>
                <span className="queued-text" title={queuedMessage}>
                  {queuedMessage}
                </span>
              </div>
              <div className="queued-strip-actions">
                <button
                  type="button"
                  className="queued-btn edit"
                  data-tip="返回修改"
                  onClick={editQueued}
                >
                  <Icon name="edit" size={12} />
                  <span>修改</span>
                </button>
                <button
                  type="button"
                  className="queued-btn steer"
                  data-tip="立即插队执行"
                  onClick={steerQueued}
                >
                  <Icon name="arrow-right" size={13} />
                  <span>立即插队</span>
                </button>
              </div>
            </div>
          )}
          <div className="composer-box">
            <textarea
              rows={2}
              placeholder={running ? "任务执行中… 输入新需求回车默认排队（Shift+Enter 换行）" : "输入任务或问题…（回车发送，Shift+Enter 换行）"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <div className="composer-toolbar">
              <div className="ct-left">
                <label className="ct-btn" data-tip="上传文件到工作区">
                  <Icon name="plus" size={15} />
                  <input type="file" hidden onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} />
                </label>
                {task && (
                  <Select
                    dropUp
                    value={modeKey || task.mode}
                    onChange={setModeKey}
                    data-tip="权限模式（可切换，下一轮生效）"
                    options={[
                      { value: "ask", label: "只读 · 仅查看不改文件" },
                      { value: "craft", label: "完整 · 可读写执行" },
                      { value: "plan", label: "计划 · 先计划再执行" },
                    ]}
                  />
                )}
              </div>
              <div className="ct-right">
                {task && (() => {
                  const curKey = `${task.provider}/${task.model_id}`;
                  const opts = [
                    { value: "auto", label: "Auto · 自动路由" },
                    ...models.map((m) => ({ value: `${m.provider_id}/${m.model_id}`, label: m.display_name || m.model_id })),
                  ];
                  if (!opts.some((o) => o.value === curKey)) opts.push({ value: curKey, label: task.model_id });
                  return (
                    <Select
                      dropUp
                      value={modelKey || curKey}
                      onChange={setModelKey}
                      data-tip="模型（可切换，下一轮生效）"
                      options={opts}
                    />
                  );
                })()}
                {running ? (
                  <div className="ct-actions">
                    <button className="ct-send stop" onClick={abort} data-tip="中止当前任务"><Icon name="square" size={12} /></button>
                    <button className="ct-send" onClick={send} disabled={!input.trim()} data-tip="排队追问 (Enter)"><Icon name="arrow-up" size={16} /></button>
                  </div>
                ) : (
                  <button className="ct-send" onClick={send} disabled={!input.trim()} data-tip="发送 (Enter)"><Icon name="arrow-up" size={16} /></button>
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
            <button className="icon-btn" onClick={() => loadFiles("")} data-tip-down data-tip="刷新"><Icon name="refresh-cw" size={13} /></button>
            <button className="icon-btn" onClick={() => setShowFiles(false)} data-tip-down data-tip="收起面板"><Icon name="x" size={13} /></button>
          </div>
          <div className="ftree">{fileTree("", 0)}</div>
          <p className="hint">点击文件下载，点击目录展开</p>
        </div>
      )}
    </div>
  );
}
