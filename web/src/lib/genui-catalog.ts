// Pure catalog for generative-ui: no React, importable from the web bundle
// AND from deploy/gen-genui-skill.mjs (node type-stripping) — single source
// of truth for what the AI may generate and what the renderer supports.
import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

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
      description: "会话按钮：点击后把 message（省略则用 label）作为用户消息发回对话，触发下一轮。只用于需要 AI 进一步行动的场景（drill-down、执行操作、生成新内容）；纯展示切换（换标签页、展开折叠）必须用 Tabs/Accordion，不要用 Button。",
    },
    Tabs: {
      props: z.object({ labels: z.array(z.string()) }),
      description: "标签页（本地交互，不触发 AI）：labels 与 children 一一对应，点击标签就地切换显示对应的子元素。适合同一数据的多视角展示（如 概览|明细|趋势）。",
    },
    Accordion: {
      props: z.object({ summary: z.string(), defaultOpen: z.boolean().optional() }),
      description: "折叠面板（本地交互，不触发 AI）：summary 为标题行，点击就地展开/收起 children。适合长内容的分章节收纳（如逐项分析、附录说明）。",
    },
    Divider: { props: z.object({}), description: "分隔线。" },
  },
  actions: {},
});
