import React from "react";
import { createSpecStreamCompiler } from "@json-render/core";
import { defineRegistry, Renderer, JSONUIProvider } from "@json-render/react";
import { genuiCatalog } from "./genui-catalog";
import Loader from "../components/Loader";
import { ErrorBoundary } from "../components/ErrorBoundary";

const toneCls: Record<string, string> = {
  default: "", success: "ok", warning: "warn", danger: "err", info: "info",
};

class GuiErrorBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: any) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: any) { console.warn("[GenerativeUI] render error caught:", err); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

function parseStreamingJson(raw: string): any {
  let s = raw.trim().replace(/```.*$/, "").trim();
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object") return obj;
  } catch {}
  if (!s.startsWith("{")) return null;

  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack.length && stack[stack.length - 1] === ch) stack.pop();
      }
    }
  }

  let candidate = s;
  if (inString) {
    if (escape) candidate = candidate.slice(0, -1);
    candidate += '"';
  }
  candidate = candidate.replace(/,\s*$/, "");

  const suffixes = [
    stack.slice().reverse().join(""),
    ": null" + stack.slice().reverse().join(""),
    stack.slice(0, -1).reverse().join(""),
  ];

  for (const suf of suffixes) {
    try {
      const fixed = candidate + suf;
      const res = JSON.parse(fixed);
      if (res && typeof res === "object") return res;
    } catch {}
  }
  return null;
}

type AnyProps = Record<string, any>;
type Impl = React.ComponentType<{ props: AnyProps; children?: React.ReactNode }>;

const impls: Record<string, Impl> = {
  Card: ({ props = {}, children }) => (
    <div className="gui-card">
      {(props.title || props.subtitle) && (
        <div className="gui-card-head">
          {props.title && <b>{props.title}</b>}
          {props.subtitle && <span className="gui-muted">{props.subtitle}</span>}
        </div>
      )}
      {children}
    </div>
  ),
  Stack: ({ props = {}, children }) => (
    <div className={`gui-stack ${props.direction === "row" ? "row" : ""}`} style={props.gap ? { gap: props.gap } : undefined}>
      {children}
    </div>
  ),
  Heading: ({ props = {} }) => {
    const Tag = (props.level || "h2") as "h1" | "h2" | "h3";
    return <Tag className={`gui-h ${Tag}`}>{props.text || ""}</Tag>;
  },
  Text: ({ props = {} }) => <p className={props.muted ? "gui-muted" : "gui-text"}>{props.text || ""}</p>,
  Badge: ({ props = {} }) => <span className={`gui-badge ${toneCls[props.tone || "default"]}`}>{props.text || ""}</span>,
  Metric: ({ props = {} }) => (
    <div className="gui-metric">
      <span className="gui-muted">{props.label}</span>
      <b className="gui-metric-val">{props.value}</b>
      {props.delta && <span className={`gui-badge ${String(props.delta).startsWith("-") ? "err" : "ok"}`}>{props.delta}</span>}
      {props.caption && <span className="gui-muted">{props.caption}</span>}
    </div>
  ),
  Table: ({ props = {} }) => {
    const cols = Array.isArray(props.columns) ? props.columns : [];
    const rows = Array.isArray(props.rows) ? props.rows : [];
    return (
      <div className="gui-table-wrap">
        <table className="gui-table">
          {props.caption && <caption className="gui-muted">{props.caption}</caption>}
          <thead><tr>{cols.map((c: string, i: number) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r: any, i: number) => {
              const cells = Array.isArray(r) ? r : typeof r === "object" && r !== null ? Object.values(r) : [r];
              return (
                <tr key={i}>
                  {cells.map((c, j) => <td key={j}>{c != null ? String(c) : ""}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  },
  Progress: ({ props = {} }) => {
    const num = typeof props.value === "number" ? props.value : parseFloat(String(props.value || 0)) || 0;
    const clamped = Math.max(0, Math.min(100, num));
    return (
      <div className="gui-progress">
        <div className="gui-progress-head"><span>{props.label}</span><span className="mono">{clamped}%</span></div>
        <div className="gui-bar"><div className="gui-bar-fill" style={{ width: `${clamped}%` }} /></div>
        {props.caption && <span className="gui-muted">{props.caption}</span>}
      </div>
    );
  },
  Alert: ({ props = {} }) => {
    const tone = props.tone || "info";
    const cls = toneCls[tone] || tone;
    return (
      <div className={`gui-alert ${cls}`}>
        {props.title && <b>{props.title}</b>}
        <span>{props.text}</span>
      </div>
    );
  },
  KeyValue: ({ props = {} }) => (
    <dl className="gui-kv">
      {(props.items || []).map((it: any, i: number) => (
        <React.Fragment key={i}><dt>{it?.key ?? ""}</dt><dd>{it?.value != null ? String(it.value) : ""}</dd></React.Fragment>
      ))}
    </dl>
  ),
  Button: ({ props = {} }) => (
    <button
      type="button"
      className="btn small gui-btn"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const msg = props.message || props.label;
        if (msg) {
          window.dispatchEvent(new CustomEvent("genui:action", { detail: { message: msg } }));
        }
      }}
    >
      {props.label}
    </button>
  ),
  Tabs: ({ props = {}, children }) => {
    const [active, setActive] = React.useState(0);
    const kids = React.Children.toArray(children);
    const labels: string[] = Array.isArray(props.labels) ? props.labels : [];
    const idx = Math.min(active, Math.max(0, kids.length - 1));
    return (
      <div className="gui-tabs">
        <div className="gui-tab-bar">
          {labels.map((l, i) => (
            <button key={i} type="button" className={`gui-tab ${i === idx ? "on" : ""}`} onClick={() => setActive(i)}>{l}</button>
          ))}
        </div>
        <div className="gui-tab-body">{kids[idx] ?? null}</div>
      </div>
    );
  },
  Accordion: ({ props = {}, children }) => {
    const [open, setOpen] = React.useState(!!props.defaultOpen);
    return (
      <div className="gui-acc">
        <button type="button" className="gui-acc-head" onClick={() => setOpen(!open)}>
          <span className={`gui-acc-chevron ${open ? "open" : ""}`}>▸</span>
          {props.summary}
        </button>
        {open && <div className="gui-acc-body">{children}</div>}
      </div>
    );
  },
  Divider: () => <hr className="gui-divider" />,
};

const { registry } = defineRegistry(genuiCatalog, { components: impls as any });

export function GenerativeUIBlock({ code }: { code: string }) {
  const trimmed = code.trim();
  const lastValidSpecRef = React.useRef<any>(null);
  let spec: any = null;
  const isPatchStream = /^\s*\{\s*"op"\s*:/.test(trimmed);

  if (isPatchStream) {
    try {
      const compiler: any = createSpecStreamCompiler({ elements: {} });
      const res: any = compiler.push(trimmed + "\n")?.result;
      if (res) {
        res.elements = res.elements || {};
        if (res.root && res.elements[res.root]) {
          spec = res;
        }
      }
    } catch { /* 容错 */ }
  } else {
    const parsed = parseStreamingJson(trimmed);
    if (parsed && typeof parsed === "object") {
      parsed.elements = parsed.elements || {};
      if (parsed.root && parsed.elements[parsed.root]) {
        spec = parsed;
      }
    }
  }

  if (spec) {
    lastValidSpecRef.current = spec;
  } else if (lastValidSpecRef.current) {
    // 保持上一帧有效 spec，防止流式 JSON 临时解析失败引起的剧烈闪烁
    spec = lastValidSpecRef.current;
  }

  if (!spec) {
    return (
      <div className="gui-wrap card gui-muted">
        <Loader label="界面生成中…" variant="Dots" />
      </div>
    );
  }

  return (
    <div className="gui-wrap card">
      <ErrorBoundary fallback={<div className="gui-wrap card gui-muted">界面生成中…</div>}>
        <JSONUIProvider registry={registry}>
          <Renderer
            spec={spec}
            registry={registry}
            fallback={() => <pre className="infographic-fallback">{code}</pre>}
          />
        </JSONUIProvider>
      </ErrorBoundary>
    </div>
  );
}
