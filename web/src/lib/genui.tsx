// Generative UI: chat renders ```json-ui fenced blocks through json-render
// (whitelisted catalog -> predictable spec -> our design-system components).
// Buttons dispatch a "genui:action" DOM event; TaskDetail listens and sends
// the message back into the conversation (interactive loop, no backend change).
import React from "react";
import { createSpecStreamCompiler } from "@json-render/core";
import { defineRegistry, Renderer, JSONUIProvider } from "@json-render/react";
import { genuiCatalog } from "./genui-catalog";

const toneCls: Record<string, string> = {
  default: "", success: "ok", warning: "warn", danger: "err", info: "info",
};

type AnyProps = Record<string, any>;
type Impl = React.ComponentType<{ props: AnyProps; children?: React.ReactNode }>;

const impls: Record<string, Impl> = {
  Card: ({ props, children }) => (
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
  Stack: ({ props, children }) => (
    <div className={`gui-stack ${props.direction === "row" ? "row" : ""}`} style={props.gap ? { gap: props.gap } : undefined}>
      {children}
    </div>
  ),
  Heading: ({ props }) => {
    const Tag = (props.level || "h2") as "h1" | "h2" | "h3";
    return <Tag className={`gui-h ${Tag}`}>{props.text}</Tag>;
  },
  Text: ({ props }) => <p className={props.muted ? "gui-muted" : "gui-text"}>{props.text}</p>,
  Badge: ({ props }) => <span className={`gui-badge ${toneCls[props.tone || "default"]}`}>{props.text}</span>,
  Metric: ({ props }) => (
    <div className="gui-metric">
      <span className="gui-muted">{props.label}</span>
      <b className="gui-metric-val">{props.value}</b>
      {props.delta && <span className={`gui-badge ${String(props.delta).startsWith("-") ? "err" : "ok"}`}>{props.delta}</span>}
      {props.caption && <span className="gui-muted">{props.caption}</span>}
    </div>
  ),
  Table: ({ props }) => (
    <table className="gui-table">
      {props.caption && <caption className="gui-muted">{props.caption}</caption>}
      <thead><tr>{(props.columns || []).map((c: string, i: number) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>
        {(props.rows || []).map((r: any[], i: number) => (
          <tr key={i}>{r.map((c, j) => <td key={j}>{String(c)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  ),
  Progress: ({ props }) => (
    <div className="gui-progress">
      <div className="gui-progress-head"><span>{props.label}</span><span className="mono">{props.value}%</span></div>
      <div className="gui-bar"><div className="gui-bar-fill" style={{ width: `${Math.max(0, Math.min(100, props.value))}%` }} /></div>
      {props.caption && <span className="gui-muted">{props.caption}</span>}
    </div>
  ),
  Alert: ({ props }) => (
    <div className={`gui-alert ${toneCls[props.tone || "info"]}`}>
      {props.title && <b>{props.title}</b>}
      <span>{props.text}</span>
    </div>
  ),
  KeyValue: ({ props }) => (
    <dl className="gui-kv">
      {(props.items || []).map((it: any, i: number) => (
        <React.Fragment key={i}><dt>{it.key}</dt><dd>{it.value}</dd></React.Fragment>
      ))}
    </dl>
  ),
  Button: ({ props }) => (
    <button
      className="btn small gui-btn"
      onClick={() => window.dispatchEvent(new CustomEvent("genui:action", { detail: { message: props.message || props.label } }))}
    >
      {props.label}
    </button>
  ),
  // Local-interaction components: state lives in the impl (React useState),
  // no LLM round-trip, no conversation message — in-place by design.
  Tabs: ({ props, children }) => {
    const [active, setActive] = React.useState(0);
    const kids = React.Children.toArray(children);
    const labels: string[] = props.labels || [];
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
  Accordion: ({ props, children }) => {
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
  // Dual wire format inside the ```json-ui fence:
  //  - one flat JSON object  -> rendered whole once complete (default, safest)
  //  - one JSON-Patch per line -> SpecStream compiler renders progressively
  // Both are recomputed idempotently from the full text on every render —
  // streaming deltas just re-run this, no cross-render state to corrupt.
  const trimmed = code.trim();
  let spec: any = null;
  const firstLine = trimmed.split("\n", 1)[0].trim();
  if (firstLine.startsWith('{"op"')) {
    try {
      const compiler = createSpecStreamCompiler();
      const { result } = compiler.push(trimmed + "\n");
      if (result && (result.root || result.elements)) spec = result;
    } catch { /* malformed patch stream */ }
  } else {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.elements) spec = parsed;
    } catch { /* still streaming */ }
  }

  if (!spec) {
    return <div className="gui-wrap card gui-muted">界面生成中…</div>;
  }
  return (
    <div className="gui-wrap card">
      <JSONUIProvider registry={registry}>
        <Renderer
          spec={spec}
          registry={registry}
          fallback={() => <pre className="infographic-fallback">{code}</pre>}
        />
      </JSONUIProvider>
    </div>
  );
}
