---
name: generative-ui-builder
description: Render interactive UI dashboards, metric cards, tables, progress panels and clickable drill-downs directly inside the chat as structured JSON. Use when the user asks for a dashboard, panel, status view, comparison card, or interactive summary with buttons. Output a fenced json-ui block.
---

# Generative UI Builder（交互界面）

This platform renders any fenced code block tagged `jsonui` (or legacy `json-ui`) as a real
interactive interface inside the chat, progressively while you stream.

## Output format (strict)

Default — one flat JSON object（小界面用这个，最稳）:

````text
```jsonui
{ "root": "...", "elements": { ... } }
```
````

Spec shape:
- `root`: id of the root element (usually a Card).
- `elements`: map of `id -> { "type", "props", "children" }`.
- `children`: array of OTHER element ids (never nested objects, never raw text).
- Text lives in component props (`text`, `label`, `title`), not in children.

Large UIs（元素多时可用）— one JSON-Patch per line, the interface renders
progressively as lines arrive:

````text
```jsonui
{"op":"add","path":"/root","value":"c1"}
{"op":"add","path":"/elements/c1","value":{"type":"Card","props":{"title":"..."},"children":[]}}
```
````

Patch ops: `add` / `replace` / `remove`（`path` 为 JSON Pointer，`value` 为目标值）。
用 patch 格式时：先 add `/root`，再逐个 add `/elements/<id>`；子元素引用可后补
（最后再 replace 根卡片的 children 补齐布局）。两种格式**二选一，不要混用**。

## Interaction loop

Buttons continue the conversation: clicking sends their `message` as a user
message. Design drill-downs with it — e.g. a metrics card plus buttons like
"看趋势", "对比上月". Keep 1-3 buttons per interface.

## Rules

- One ```jsonui block per turn.
- Keep it to ~4-8 Metric rows or ~6 Table rows per card; summarize the rest in
  text after the block.
- value in Metric is a string — format it yourself ("12,480", "+18.6%").
- All numbers must come from the conversation or your tools. Never fabricate.
- After the block, add one short paragraph of takeaways.
- Valid JSON only — no trailing commas, no comments, escape quotes in text.

<!-- genui-catalog-prompt:start -->

AVAILABLE COMPONENTS (12):

- Card: { title?: string, subtitle?: string } - 卡片容器。整个界面的根元素通常是一个 Card，其余元素作为它的 children。
- Stack: { direction?: "row" | "column", gap?: number } - 布局容器，纵向或横向排列子元素。direction 默认 column。
- Heading: { text: string, level?: "h1" | "h2" | "h3" } - 标题。h1 最大，默认 h2。
- Text: { text: string, muted?: boolean } - 正文文本。muted=true 显示为次要说明文字。
- Badge: { text: string, tone?: "default" | "success" | "warning" | "danger" | "info" } - 状态徽标/标签，用于简短状态或分类标记。
- Metric: { label: string, value: string, delta?: string, caption?: string } - 指标卡：label 名称、value 数值字符串、delta 环比变化（如 +12%）、caption 补充说明。
- Table: { columns: Array<string>, rows: Array<Array<string | number>>, caption?: string } - 数据表格。columns 为列名数组，rows 为二维数组（每行与列对齐，单元格为字符串或数字）。
- Progress: { label: string, value: number, caption?: string } - 进度条。value 取 0-100。
- Alert: { title?: string, text: string, tone?: "info" | "warning" | "danger" | "success" } - 提示/警示区块。
- KeyValue: { items: Array<{ key: string, value: string }> } - 键值对清单，适合属性、配置、摘要信息。
- Button: { label: string, message?: string } - 交互按钮：点击后把 message（省略则用 label）作为用户消息发回对话，触发下一步。用于 drill-down、确认、切换视角等。
- Divider: {  } - 分隔线。

<!-- genui-catalog-prompt:end -->

## Example (flat object)

````text
```jsonui
{
  "root": "c1",
  "elements": {
    "c1": { "type": "Card", "props": { "title": "本月平台概览", "subtitle": "截至 09-22" }, "children": ["s1", "s2", "s3"] },
    "s1": { "type": "Stack", "props": { "direction": "row", "gap": 12 }, "children": ["m1", "m2", "m3"] },
    "m1": { "type": "Metric", "props": { "label": "活跃用户", "value": "128", "delta": "+12%", "caption": "WAU" }, "children": [] },
    "m2": { "type": "Metric", "props": { "label": "任务总数", "value": "1,043", "delta": "+8%" }, "children": [] },
    "m3": { "type": "Metric", "props": { "label": "Token 消耗", "value": "2.1M", "delta": "-3%" }, "children": [] },
    "s2": { "type": "Table", "props": { "columns": ["专家", "任务数", "占比"], "rows": [["文档大师", 41, "39%"], ["团队大脑", 28, "27%"], ["仓库管家", 19, "18%"]] }, "children": [] },
    "s3": { "type": "Stack", "props": { "direction": "row" }, "children": ["b1", "b2"] },
    "b1": { "type": "Button", "props": { "label": "看 7 日趋势", "message": "画一下近 7 日活跃用户趋势" }, "children": [] },
    "b2": { "type": "Button", "props": { "label": "按部门拆分", "message": "按部门拆分本月任务数" }, "children": [] }
  }
}
```
````
