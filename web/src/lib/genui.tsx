// Generative UI: chat renders ```json-ui fenced blocks through json-render
// (whitelisted catalog -> predictable spec -> our design-system components).
// Buttons dispatch a "genui:action" DOM event; TaskDetail listens and sends
// the message back into the conversation (interactive loop, no backend change).
import React from "react";
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { defineRegistry, Renderer } from "@json-render/react";
import { z } from "zod";

const toneCls: Record<string, string> = {
  default: "", success: "ok", warning: "warn", danger: "err", info: "info",
};

export const genuiCatalog = defineCatalog(schema, {
  components: {
    Card: {
      props: z.object({ title: z.string().optional(), subtitle: z.string().optional() }),
      description: "卡片容器。整个界面的根元素通常是一个 Card，其余元素作为它的 children。",
    },
    Stack: {
      props: z.object({ direction: z.enum(["row", "column"]).optional(), gap: z.number().optional() }),
      description: "布局容器，纵向或横向排列子元素。direction 默认 column。",
    },
    Heading: {
      props: z.object({ text: z.string(), level: z.enum(["h1", "h2", "h3"]).optional() }),
      description: "标题。h1 最大，默认 h2。",
    },
    Text: {
      props: z.object({ text: z.string(), muted: z.boolean().optional() }),
      description: "正文文本。muted=true 显示为次要说明文字。",
    },
    Badge: {
      props: z.object({ text: z.string(), tone: z.enum(["default", "success", "warning", "danger", "info"]).optional() }),
      description: "状态徽标/标签，用于简短状态或分类标记。",
    },
    Metric: {
      props: z.object({
        label: z.string(), value: z.string(),
        delta: z.string().optional(), caption: z.string().optional(),
      }),
      description: "指标卡：label 名称、value 数值字符串、delta 环比变化（如 +12%）、caption 补充说明。",
    },
    Table: {
      props: z.object({
        columns: z.array(z.string()),
        rows: z.array(z.array(z.union([z.string(), z.number()]))),
        caption: z.string().optional(),
      }),
      description: "数据表格。columns 为列名数组，rows 为二维数组（每行与列对齐，单元格为字符串或数字）。",
    },
    Progress: {
      props: z.object({ label: z.string(), value: z.number(), caption: z.string().optional() }),
      description: "进度条。value 取 0-100。",
    },
    Alert: {
      props: z.object({
        title: z.string().optional(), text: z.string(),
        tone: z.enum(["info", "warning", "danger", "success"]).optional(),
      }),
      description: "提示/警示区块。",
    },
    KeyValue: {
      props: z.object({ items: z.array(z.object({ key: z.string(), value: z.string() })) }),
      description: "键值对清单，适合属性、配置、摘要信息。",
    },
    Button: {
      props: z.object({ label: z.string(), message: z.string().optional() }),
      description: "交互按钮：点击后把 message（省略则用 label）作为用户消息发回对话，触发下一步。用于 drill-down、确认、切换视角等。",
    },
    Divider: { props: z.object({}), description: "分隔线。" },
  },
  actions: {},
});

type AnyProps = Record<string, any>;
type Impl = React.ComponentType<{ element: { props: AnyProps }; children?: React.ReactNode }>;

const impls: Record<string, Impl> = {
  Card: ({ element, children }) => (
    <div className="gui-card">
      {(element.props.title || element.props.subtitle) && (
        <div className="gui-card-head">
          {element.props.title && <b>{element.props.title}</b>}
          {element.props.subtitle && <span className="gui-muted">{element.props.subtitle}</span>}
        </div>
      )}
      {children}
    </div>
  ),
  Stack: ({ element, children }) => (
    <div className={`gui-stack ${element.props.direction === "row" ? "row" : ""}`} style={element.props.gap ? { gap: element.props.gap } : undefined}>
      {children}
    </div>
  ),
  Heading: ({ element }) => {
    const Tag = (element.props.level || "h2") as "h1" | "h2" | "h3";
    return <Tag className={`gui-h ${Tag}`}>{element.props.text}</Tag>;
  },
  Text: ({ element }) => <p className={element.props.muted ? "gui-muted" : "gui-text"}>{element.props.text}</p>,
  Badge: ({ element }) => <span className={`gui-badge ${toneCls[element.props.tone || "default"]}`}>{element.props.text}</span>,
  Metric: ({ element }) => (
    <div className="gui-metric">
      <span className="gui-muted">{element.props.label}</span>
      <b className="gui-metric-val">{element.props.value}</b>
      {element.props.delta && <span className={`gui-badge ${String(element.props.delta).startsWith("-") ? "err" : "ok"}`}>{element.props.delta}</span>}
      {element.props.caption && <span className="gui-muted">{element.props.caption}</span>}
    </div>
  ),
  Table: ({ element }) => (
    <table className="gui-table">
      {element.props.caption && <caption className="gui-muted">{element.props.caption}</caption>}
      <thead><tr>{(element.props.columns || []).map((c: string, i: number) => <th key={i}>{c}</th>)}</tr></thead>
      <tbody>
        {(element.props.rows || []).map((r: any[], i: number) => (
          <tr key={i}>{r.map((c, j) => <td key={j}>{String(c)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  ),
  Progress: ({ element }) => (
    <div className="gui-progress">
      <div className="gui-progress-head"><span>{element.props.label}</span><span className="mono">{element.props.value}%</span></div>
      <div className="gui-bar"><div className="gui-bar-fill" style={{ width: `${Math.max(0, Math.min(100, element.props.value))}%` }} /></div>
      {element.props.caption && <span className="gui-muted">{element.props.caption}</span>}
    </div>
  ),
  Alert: ({ element }) => (
    <div className={`gui-alert ${toneCls[element.props.tone || "info"]}`}>
      {element.props.title && <b>{element.props.title}</b>}
      <span>{element.props.text}</span>
    </div>
  ),
  KeyValue: ({ element }) => (
    <dl className="gui-kv">
      {(element.props.items || []).map((it: any, i: number) => (
        <React.Fragment key={i}><dt>{it.key}</dt><dd>{it.value}</dd></React.Fragment>
      ))}
    </dl>
  ),
  Button: ({ element }) => (
    <button
      className="btn small gui-btn"
      onClick={() => window.dispatchEvent(new CustomEvent("genui:action", { detail: { message: element.props.message || element.props.label } }))}
    >
      {element.props.label}
    </button>
  ),
  Divider: () => <hr className="gui-divider" />,
};

const { registry } = defineRegistry(genuiCatalog, { components: impls as any });

export function GenerativeUIBlock({ code }: { code: string }) {
  let spec: any = null;
  try {
    spec = JSON.parse(code);
  } catch {
    return <pre className="infographic-fallback">{code}</pre>;
  }
  return (
    <div className="gui-wrap card">
      <Renderer
        spec={spec}
        registry={registry}
        fallback={() => <pre className="infographic-fallback">{code}</pre>}
      />
    </div>
  );
}
