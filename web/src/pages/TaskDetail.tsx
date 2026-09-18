import React, { useEffect, useRef, useState } from "react";
import { api, TaskInfo } from "../lib/api";
import { Markdown } from "../lib/md";

interface ToolCard { id: string; tool: string; args: string; output: string; done: boolean; error?: boolean }
interface Bubble { role: "user" | "assistant"; text: string; thinking?: string; tools: ToolCard[]; streaming?: boolean }

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[工具调用 ${c.name}]` : "")).join("");
  }
  return "";
}

export function TaskDetail({ taskId }: { taskId: string }) {
  const [task, setTask] = useState<TaskInfo | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [files, setFiles] = useState<Record<string, { name: string; is_dir: boolean; size: number }[]>>({});
  const [dirOpen, setDirOpen] = useState<Record<string, boolean>>({ "": true });
  const [showFiles, setShowFiles] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.tasks.get(taskId).then((r) => setTask(r.task)).catch(() => {});
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
        setRunning(false);
        cur = null;
        update((b) => ({ ...b, streaming: false }));
        refreshTask(); loadFiles("");
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles, notice]);

  const refreshTask = () => api.tasks.get(taskId).then((r) => setTask(r.task)).catch(() => {});
  const loadHistory = async () => {
    try {
      const r = await api.tasks.history(taskId);
      const bs: Bubble[] = [];
      for (const m of r.messages) {
        if (m.role === "user") bs.push({ role: "user", text: contentToText(m.content), tools: [] });
        else if (m.role === "assistant") bs.push({ role: "assistant", text: contentToText(m.content), tools: [] });
      }
      setBubbles(bs);
    } catch { /* ignore */ }
  };

  const loadFiles = async (path: string) => {
    try {
      const r = await api.files.list(path);
      setFiles((prev) => ({ ...prev, [path]: r.nodes }));
    } catch { /* ignore */ }
  };

  const send = async (behavior?: string) => {
    if (!input.trim()) return;
    const msg = input;
    setInput("");
    setBubbles((prev) => [...prev, { role: "user", text: msg, tools: [] }]);
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
      {{ pending: "待处理", running: "执行中", idle: "空闲", failed: "失败", archived: "已归档" }[task.status] || task.status}
    </span>
  );

  const fileTree = (path: string, depth: number): React.ReactNode => {
    const nodes = files[path] || [];
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
              {dirOpen[full] ? "▾" : "▸"} {n.name}
            </div>
            {dirOpen[full] && fileTree(full, depth + 1)}
          </div>
        );
      }
      return (
        <div key={full} className="fnode" style={{ paddingLeft: depth * 14 + 16 }} onClick={() => download(full)}>
          {n.name} <span className="fsize">{n.size}B</span>
        </div>
      );
    });
  };

  return (
    <div className="detail">
      <div className={`chat ${showFiles ? "" : "wide"}`} ref={scrollRef}>
        <div className="detail-head">
          <a href="#/tasks" className="back">←</a>
          <h3>{task?.title || "任务"}</h3>
          {statusBadge}
          {task && <span className="chip">{task.mode} · {task.model_id}</span>}
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setShowFiles(!showFiles)}>{showFiles ? "隐藏产物" : "显示产物"}</button>
        </div>

        {notice && <div className="notice">{notice}</div>}

        <div className="bubbles">
          {bubbles.map((b, i) => (
            <div key={i} className={`bubble ${b.role}`}>
              {b.role === "assistant" && b.thinking && (
                <details className="thinking"><summary>思考过程</summary><div>{b.thinking}</div></details>
              )}
              {b.tools.map((t) => (
                <details key={t.id} className={`toolcard ${t.error ? "err" : ""}`}>
                  <summary>
                    <span className="toolname">{t.tool}</span>
                    <span className="toolstate">{t.done ? (t.error ? "✗" : "✓") : "…"}</span>
                  </summary>
                  <pre className="toolargs">{t.args}</pre>
                  {t.output && <pre className="toolout">{t.output}</pre>}
                </details>
              ))}
              {b.text ? <Markdown text={b.text} /> : b.streaming ? <span className="cursor">▍</span> : null}
            </div>
          ))}
          {bubbles.length === 0 && <div className="empty">发送第一条消息开始任务</div>}
        </div>

        <div className="composer">
          <label className="btn ghost attach" title="上传到工作区">
            📎<input type="file" hidden onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} />
          </label>
          <textarea
            rows={2}
            placeholder={running ? "任务执行中… 可追问（回车排队，Shift+Enter 换行）" : "输入任务或问题…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(running ? "follow_up" : undefined); }
            }}
          />
          {running ? (
            <>
              <button className="btn warn" onClick={abort}>中止</button>
              <button className="btn" onClick={() => send("follow_up")}>排队追问</button>
            </>
          ) : (
            <button className="btn primary" onClick={() => send()} disabled={!input.trim()}>发送</button>
          )}
        </div>
      </div>

      {showFiles && (
        <div className="files card">
          <h4>工作区产物</h4>
          <div className="ftree">{fileTree("", 0)}</div>
          <p className="hint">点击文件下载；目录点击展开</p>
        </div>
      )}
    </div>
  );
}
