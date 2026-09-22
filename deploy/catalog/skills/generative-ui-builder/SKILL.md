---
name: generative-ui-builder
description: Render interactive UI dashboards, metric cards, tables, progress panels and clickable drill-downs directly inside the chat as structured JSON. Use when the user asks for a dashboard, panel, status view, comparison card, or interactive summary with buttons. Output a fenced json-ui block.
---

# Generative UI Builder（交互界面）

This platform renders any fenced code block tagged `json-ui` (JSON spec) as a real
interactive interface inside the chat. Emit valid JSON only — no HTML, no React code.

## Output format (strict)

````text
```json-ui
{ "root": "...", "elements": { ... } }
```
````

Spec shape:
- `root`: id of the root element (usually a Card).
- `elements`: map of `id -> { "type", "props", "children" }`.
- `children`: array of OTHER element ids (never nested objects, never raw text).
- Text lives in component props (`text`, `label`, `title`), not in children.
- Every referenced id must exist in `elements`; every element (except root) should
  be reachable from root.

## Component whitelist (anything else fails to render)

| type | key props | use for |
|---|---|---|
| Card | title?, subtitle? | root container |
| Stack | direction?: row/column, gap? | layout |
| Heading | text, level?: h1/h2/h3 | titles |
| Text | text, muted? | body copy |
| Badge | text, tone?: default/success/warning/danger/info | status chips |
| Metric | label, value, delta?, caption? | KPI numbers |
| Table | columns: string[], rows: (string\|number)[][], caption? | data tables |
| Progress | label, value (0-100), caption? | progress |
| Alert | text, title?, tone?: info/warning/danger/success | callouts |
| KeyValue | items: [{key, value}] | property lists |
| Button | label, message? | interaction: click sends `message` (or label) back as the user's next message |
| Divider | — | separation |

## Interaction loop

Buttons continue the conversation: clicking sends their `message` as a user
message. Design drill-downs with it — e.g. a metrics card plus buttons like
"看趋势", "对比上月", message values the user would plausibly send. Keep 1–3
buttons per interface.

## Rules

- One ```json-ui block per turn (multiple blocks are allowed only if the user
  asks for several separate views).
- Keep it to ~4-8 Metric rows or ~6 Table rows per card; summarize the rest in
  text after the block.
- value in Metric is a string — format it yourself ("12,480", "+18.6%").
- All numbers must come from the conversation or your tools. Never fabricate.
- After the block, add one short paragraph of takeaways.
- Prefer Table for >4 comparable items, Metric row for <=4 headline numbers.
- JSON must be valid — no trailing commas, no comments, escape quotes in text.

## Example

````text
```json-ui
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
