---
name: excel-master
description: Excel 解析/生成/修改专家。处理 .xlsx/.csv 的读取、结构化构建、公式与图表生成、批量修改。用户在 Excel 文件上提需求就用这个技能。
allowed-tools: Bash(python3:*)
license: MIT
compatibility: 需 runtime 镜像预装 openpyxl + pandas(见 deploy/Dockerfile.runtime)
metadata:
  expert: excel-master
  category: spreadsheet
  author: agentluoss
---

# Excel Master — 电子表格处理技能

> **何时使用**:用户上传 .xlsx / .csv / .xls,或要求"生成 Excel / 报表 / 趋势 / 透视 / 批量改"。
> **何时不使用**:PDF / Word / PPT / 图片处理(用其他技能)。

## 工作流(模型严格按此推进)

```
[1] ls + read 用户上传的文件 → 确认路径
[2] python3 tools/excel_inspect.py <file>  → 看 sheets / 表头 / 公式 / 图表
[3] 规划 spec(写到 spec JSON) → 写明 表头/数据行/公式列/图表规格
[4] python3 tools/excel_build.py --spec <spec.json> --out <out.xlsx>  → 生成数据 + 公式
[5] python3 tools/excel_chart.py --xlsx <out.xlsx> --spec <charts.json>  → 加图表
[6] python3 tools/excel_summary.py <out.xlsx>  → 抽取数字辅助结论
[7] python3 tools/excel_audit.py <out.xlsx> --candidate-only  → 审计公式覆盖
    if verdict=NEEDS_REVIEW:
      读 violations → 自己裁决哪些是漏写公式 / 哪些是故意静态
      用 openpyxl 重写被标记的 cell 为公式
      重跑 audit 一次(只允许一次重写,不递归)
    if verdict=PASS:
      继续 [8]
[8] 输出 chat 总结(2-3 条关键趋势) + 列出"故意静态"的 cell(让用户能审计)
```

## 数据血缘与公式优先(必读)

**核心原则**:**能写公式的 cell 必须写公式,绝不写静态值**。理由:
- **可审计**:鼠标点 cell 看公式栏,知道数字怎么算出来的
- **可重算**:原始 CSV 改了,聚合层数字自动更新,不用重新跑
- **可追溯**:看公式引用能直接追到源数据 sheet

### 3 层数据架构(必用)

xlsx 必须分 3 层,缺一不可:

| 层 | 作用 | sheet 命名规范 | 内容 |
|---|---|---|---|
| **Layer 1 原始数据** | 不动的源数据 | `01_原始数据` / `raw` / `源数据` | CSV 直接粘入,**全静态值**,无公式 |
| **Layer 2 转换层** | 清洗 / 过滤 / 关联 | `02_清洗` / `数据清洗` / `transform` | **公式引用 Layer 1**,如 `=IF(L1!退货, 0, L1!销售额)` |
| **Layer 3 展示层** | 聚合 / 排序 / 图表 | `03_大盘业绩` / `汇总` / `报表` | **公式引用 Layer 1 或 2**,如 `=SUMIFS(L1!销售额, L1!年份, 2025)` |

### audit 工作机制(`tools/excel_audit.py`)

LLM 写完 xlsx **必须**调 audit 一次:

```bash
python3 tools/excel_audit.py <out.xlsx> --candidate-only --json
```

- **code 部分**:扫 xlsx,按启发式标记"应该是公式的候选 cell"——sheet 名含 `汇总/大盘/计算/聚合/报表` 且公式占比 < 30%,或单 cell 数字 > 100 且周围无公式邻居
- **LLM 部分**:拿 candidate 清单,**自己裁决**:
  - 该 cell 是漏写公式 → 重写为正确公式
  - 该 cell 是故意静态(年份/标签/输入参数)→ 保留,在 chat 里告诉用户

**重写规则**(写死):
- 最多重写 1 次(不递归)
- 重写后 audit 还有违规 → **不再重试**,直接告诉用户"这 N 个 cell 是故意静态,理由是 X / Y / Z"

### ❌ 反面例子

```python
# ❌ 错:用 pandas 算完直接写数字
df = pd.read_csv('sales.csv')
total = df['sales'].sum()
ws['B5'] = total  # 16700.0 — 静态值,后续改 CSV 不会跟着变
ws['B6'] = total / df['sales'].sum()  # 1.0 — 静态值

# ✅ 对:写公式
ws['B5'] = '=SUM(原始数据!D:D)'
ws['B6'] = '=B5/SUM(原始数据!D:D)'
```

## 工具脚本约定

所有脚本统一 CLI: `--help` 列参数,统一 JSON 输入输出,详细参数见各脚本头部。

| 脚本 | 输入 | 输出 | 用途 |
|---|---|---|---|
| `excel_inspect.py` | `<xlsx>` | JSON 到 stdout | 读现有 xlsx 结构 |
| `excel_build.py` | `--spec <json> --out <xlsx>` | xlsx 文件 | 写数据 + 公式 + 样式 |
| `excel_chart.py` | `--xlsx <f> --spec <json>` | 改写 xlsx | 加图表(柱/折线/面积/双轴) |
| `excel_summary.py` | `<xlsx>` | JSON 到 stdout | 提取数字供总结 |
| `excel_audit.py` | `<xlsx> [--candidate-only --json]` | 文本/JSON 到 stdout | 审计公式覆盖,标"应是公式但写死"的 cell |

## 公式规范

- **同比增长率**(列 C)从第 2 行开始,公式:`=(B3-B2)/B2`,第 1 行(基年)留空或写"—"
- **占比**(列 E)用 `=D{r}/SUM(D$2:D${last})` 或 `=D{r}/H{r}`(若有"中国出口总额"行)
- 所有公式保留 `data_only=False` 写入(便于 Excel 重算);**不要**预先 `evaluate`
- 数值保留 2 位小数:百分比格式 `0.00%`,绝对数格式 `#,##0.00`
- 货币/数值单元格写完公式后,**同时**给单元格设置 `number_format`

## 图表规范

- **双轴折线图**(组合图):交易额 + 出口占比 共用 X 轴,Y 轴分左右
  - 用 `openpyxl.chart.LineChart` 两次,主图设 `y_axis.crosses="autoZero"`,副图设 `y_axis.crosses="max"` + `y_axis.axId` 不同
  - 主图颜色 `4472C4`(蓝),副图颜色 `ED7D31`(橙)
- **面积图**用 `openpyxl.chart.AreaChart`,颜色半透明 `8FAADC` 8FAADC60
- **柱状图**用 `BarChart` 或 `ColumnChart`,颜色 `4472C4`
- 图表标题字号 14,X/Y 轴标签字号 10
- 锚点用 `H2` / `H20` 等远离数据区
- 尺寸默认 `chart.width=18, chart.height=10`(cm)

## 样式规范

- 表头:加粗 + 底色 `#D9E2F3` + 居中 + 边框
- 数据行:左对齐 + 边框
- 公式列:右对齐 + 数字格式 `0.00%`(百分比列)/ `#,##0.00`(金额列)
- 中文:runtime 已装 `fonts-noto-cjk`(见 Dockerfile),不需额外处理

## 常见坑

| 坑 | 解决 |
|---|---|
| 公式写入后值不显示 | openpyxl 写入只存公式字符串,Excel 打开时重算;不要 `data_only=True` 读(会丢公式) |
| 中文字符乱码 | openpyxl 写中文无问题,字体已装 |
| 图表 X 轴年份显示为 `2015.0` | categories 列用整数,源数据别转 float |
| 图表数据范围不够 | Reference 用 `min_col, max_col, min_row-1, max_row` 含表头 |
| 双轴只显示一边 | 副图必须 `y_axis.axId` 与主图不同,并 `crosses="max"` |
| 大文件很慢 | `openpyxl.load_workbook(..., read_only=True)` 只读模式 |

## MVP 场景(完整可抄的范例)

**用户原始需求**:跨境电商交易额与出口占比近 10 年趋势,生成 .xlsx 包含 6 列 + 双轴折线 + 出口额面积图 + 关键趋势总结。

**推荐 spec**(完整示例见 `sample_data/cross_border_ecom.json`):

```json
{
  "sheets": [{
    "name": "趋势数据",
    "title": "中国跨境电商交易额与出口占比趋势(2015-2024)",
    "headers": ["年份", "跨境电商交易额(万亿元)", "同比增长率",
                "跨境电商出口额(万亿元)", "出口占中国出口总额比例(%)",
                "数据来源备注"],
    "rows": [
      [2015, 5.4, "", 4.0, "", "商务部、海关总署"],
      [2016, 6.7, "", 5.0, "", "商务部跨境电商报告"],
      ...
    ],
    "formulas": [
      {"cell": "C3", "formula": "=(B3-B2)/B2", "number_format": "0.00%"},
      {"cell": "E3", "formula": "=D3/(B3+D3)", "number_format": "0.00%"}
    ],
    "summary_cell": "A20"
  }],
  "summary_text": "趋势总结:\n1. 近 10 年中国跨境电商交易额从 5.4 万亿元增长到 25.4 万亿元,CAGR 约 18.8%。\n2. 跨境电商出口占整体出口比重逐年提高,2024 年已超过 45%。\n3. 2020 年受疫情影响,增速短期回落但很快反弹,行业韧性显著。"
}
```

**chart spec**:

```json
{
  "sheet": "趋势数据",
  "charts": [
    {
      "type": "combo_dual_axis_line",
      "anchor": "H2",
      "title": "跨境电商交易额 vs 出口占比(双轴)",
      "primary": {
        "series_col": "B", "header_row": 1, "data_row_start": 2, "data_row_end": 11,
        "name": "交易额(万亿元)"
      },
      "secondary": {
        "series_col": "E", "header_row": 1, "data_row_start": 2, "data_row_end": 11,
        "name": "出口占比"
      },
      "categories_col": "A", "categories_row_start": 2, "categories_row_end": 11
    },
    {
      "type": "area",
      "anchor": "H22",
      "title": "跨境电商出口额趋势(面积图)",
      "series_col": "D", "header_row": 1, "data_row_start": 2, "data_row_end": 11,
      "categories_col": "A", "categories_row_start": 2, "categories_row_end": 11,
      "name": "出口额(万亿元)"
    }
  ]
}
```

**调用**:

```bash
python3 tools/excel_build.py \
  --spec sample_data/cross_border_ecom.json \
  --out /data/workspaces/<userId>/跨境电商_趋势.xlsx

python3 tools/excel_chart.py \
  --xlsx /data/workspaces/<userId>/跨境电商_趋势.xlsx \
  --spec sample_data/cross_border_ecom.charts.json

python3 tools/excel_summary.py /data/workspaces/<userId>/跨境电商_趋势.xlsx
```

## 后续扩展点(本技能不实现,留 hook)

- 数据透视:`tools/excel_pivot.py`
- 批量差异对比:`tools/excel_diff.py`
- 大文件 streaming:`openpyxl` `read_only=True` / `write_only=True` 模式
- .xls 旧格式:加 `xlrd` 到 pip,inspect 路径与 xlsx 相同

## 输出规范(给用户看)

任务结束时 chat 回复必须包含:
1. 生成的 xlsx 路径(绝对路径或相对工作区)
2. 2-3 条关键趋势总结
4. 提示用户用 Excel / WPS / LibreOffice 打开查看(图表需 Excel 重算后才能完整显示)

**不要**在 chat 里打印整个 xlsx 内容。