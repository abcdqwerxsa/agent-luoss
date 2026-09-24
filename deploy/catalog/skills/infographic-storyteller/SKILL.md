---
name: infographic-storyteller
description: Turn data and structured information into rendered infographics inside the chat. Use when the user asks to visualize data, make an infographic/chart/poster, summarize items visually, or present steps/comparisons/lists as graphics. Output AntV Infographic DSL in fenced blocks.
---

# Infographic Storyteller（信息图创作）

You render infographics INLINE in this platform: the chat UI renders any fenced
code block tagged `infographic` as an actual graphic (AntV Infographic, SVG).
Your job: choose the right template for the data's story, then emit one fenced
block with valid DSL. Keep surrounding prose minimal — the graphic is the answer.

## Output format (strict)

Wrap DSL in a fenced block with language tag `infographic`:

````
```infographic
infographic <template-name>
data
  title <short title>
  desc <one-line subtitle>
  <items-field>
    - label <text>
      value <number>
      desc <short text>
      icon <english keyword>
```
````

Rules:
- Exactly one `infographic` line first: `infographic <template-name>`.
- Then a `data` block. Indentation = 2 spaces per level; list items start with `- `.
- Item fields go on their own lines, indented 2 more spaces under the item label.
- Never emit JSON, HTML, or chart library code — only this DSL.
- If the data doesn't fit any template below, present it as a markdown table instead
  and say the graphic form is coming.

## Templates (stick to these)

| Template | Items field | Best for |
|---|---|---|
| `list-row-simple-horizontal-arrow` | lists | 流程链、漏斗、因果链（横向箭头串联） |
| `list-row-horizontal-icon-arrow` | lists | 同上，但每项带图标更醒目 |
| `list-grid-compact-card` | lists | 清单、特性集、购物/资产列表（网格卡片） |
| `sequence-steps-simple` | sequences | 步骤、阶段、里程碑（无序强调） |
| `sequence-stairs-front-pill-badge` | sequences | 职级/等级/优先级阶梯（配 order asc/desc） |

Item fields: `label`（必须）、`value`（数值）、`desc`（补充说明）、
`icon`（英文关键词，库按词自动配图标，如 `rocket`、`users`、`chart`、`database`）。
`sequences` 数据可加 `order asc` 或 `order desc` 行声明排序方向。

Optional theme block after `data`（默认即可，用户要求风格时才加）:

```
theme
  colorBg #ffffff
  colorPrimary #2f6fed
  palette #2f6fed #13ce66 #ff5a5f
```

## Choosing the story shape

- 数值对比/排行 → lists + value，模板 `list-row-horizontal-icon-arrow`
- 顺序/流程/时间 → sequences 或 arrow 模板
- 等级/分层 → `sequence-stairs-front-pill-badge` + order
- 平行清单 → `list-grid-compact-card`
- 超过 7 项：只保留最重要的 5–7 项，其余在图后用一行文字带过。
- 用户给的数据不全时：不要编造数值——用 label/desc 呈现定性信息，并说明缺哪些数值。

## Examples

购物清单:

````
```infographic
infographic list-grid-compact-card
data
  title 购买水果清单
  lists
    - label 西瓜
      icon watermelon
    - label 苹果
      icon apple
    - label 香蕉
      icon banana
```
````

增长引擎（数值对比）:

````
```infographic
infographic list-row-horizontal-icon-arrow
data
  title 客户增长引擎
  desc 多渠道触达与复购提升
  lists
    - label 线索获取
      value 18.6
      desc 渠道投放与内容获客
      icon megaphone
    - label 转化提效
      value 12.4
      desc 线索评分与自动跟进
      icon filter
```
````

步骤序列:

````
```infographic
infographic sequence-steps-simple
data
  title 数据接入四步走
  sequences
    - label 采集
    - label 清洗
    - label 建模
    - label 看板
```
````
