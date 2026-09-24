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
[3] 规划(LLM 必读,build 前必填):
    a. 分析任务所需的数据,列出需要复制到 excel 中的原始数据(从用户上传 CSV / xlsx 筛选)
    b. 分析任务需求,列出需要生成哪些表格
    c. 对每个表格写出设计意图:
       - 数据来源(从哪个原始层 / 哪个 sheet 取)
       - 公式选择 + 理由(为什么这个公式对当前数据形态最合适)
       - 图表选择 + 理由(为什么这个图表能呈现结论)
       - 审计要求(哪些 cell 易误写静态,需公式)
    LLM 不确定时,查阅下文"openpyxl / pandas 工具运行查询"章节查询真实 API
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

## 公式与图表参考

本节是**模式库**(不是任务模板)——LLM 按当前任务的数据形态从中挑选,不要硬套。

### 公式模式

每个模式:`<使用场景>` + `<语法>` + `<保护边界>` + `<示例>`。

#### 增长率 / 同比 / 环比
- **同比**(年 vs 年):`=(本期-上年同期)/上年同期`
- **环比**(本期 vs 上期):`=(本期-上期)/上期`
- **保护**:上期 = 0 时返回 `""` 或用 `IFERROR(..., "")` 避免 `#DIV/0!`
- 示例:`=IFERROR((B3-B2)/B2, "")` · `=(B3-B2)/B2` 不带保护会出 `#DIV/0!`

#### 占比 / 份额 / 累计
- **占比**:`=x/SUM(范围)`
- **累计**:`=SUM($X$2:X2)` —— 锁定首行,行号相对当前
- **滚动 N 期求和**:`=SUM(OFFSET(X2, -N+1, 0, N, 1))`(N=窗口大小)
- **保护**:SUM=0 用 `IFERROR`
- 示例:`=IFERROR(D3/SUM(D$2:D$100), "")` · `=SUM(B$2:B2)`

#### 排名 / TopN
- **排名**:`=RANK.EQ(x, 范围, 0)` —— 0 降序 / 1 升序;`RANK.AVG` 返回平均名次
- **找 TopN 阈值**:`=LARGE(范围, N)`(第 N 大);`=SMALL` 同理
- 示例:`=RANK.EQ(C3, C$2:C$100, 0)`

#### 聚合 / 条件聚合
- **单条件求和**:`=SUMIF(条件列, 条件, 求和列)`
- **多条件求和**:`=SUMIFS(求和列, 条件列1, 条件1, 条件列2, 条件2, ...)`
- **单条件计数**:`=COUNTIF(范围, 条件)`
- **多条件计数**:`=COUNTIFS(...)`
- **按条件最大值/最小值**:`=MAXIFS(...)` / `=MINIFS(...)`(2016+)
- **加权平均**:`=SUMPRODUCT(值列, 权重列)/SUM(权重列)`
- 示例:`=SUMIFS(销售额, 区域, "华东", 渠道, "<>线上电商")`

#### 查找 / 关联 / 匹配
- **现代推荐**:`=XLOOKUP(查找值, 查找列, 返回列, "未找到")`(Office 365+)
- **经典**:`=INDEX(返回列, MATCH(查找值, 查找列, 0))` —— 0=精确
- **垂直查找(单列)**:`=VLOOKUP(查找值, 表区域, 返回列号, FALSE)` —— FALSE=精确
- **左查找**:`=VLOOKUP` 不支持向左,用 `INDEX/MATCH` 代替

#### 异常 / 校验 / 错误处理
- **异常值标记**:`=IF(ABS((x-AVERAGE(范围))/STDEV(范围))>3, "异常", "")` —— 3σ 准则
- **包裹错误**:`=IFERROR(公式, fallback)`
- **空值处理**:`=IF(ISBLANK(x), "", x)` 或 `=IFERROR(x, "")`

#### 文本 / 日期
- **拼接**:`=A1&B2` 或 `=CONCAT(A1, " - ", B2)`
- **左/中/右**:`=LEFT(s, n)` / `=MID(s, start, n)` / `=RIGHT(s, n)`
- **日期提取**:`=YEAR(日期)` / `=MONTH(日期)` / `=DAY(日期)`
- **月份差**:`=DATEDIF(开始, 结束, "m")` —— "m"月 / "d"天 / "y"年
- **格式日期**:`=TEXT(日期, "yyyy-mm")`

#### 数字 / 舍入
- **取整**:`=ROUND(x, 2)` —— 2 位小数
- **向上/向下**:`=ROUNDUP` / `=ROUNDDOWN`
- **唯一计数**:`=SUMPRODUCT(1/COUNTIF(范围, 范围))`(范围里 unique 值数)

### 图表模式

每个模式:`<openpyxl 类>` + `<适用>` + `<关键参数>` + `<坑>`。

#### 柱状图(分类对比)
```python
from openpyxl.chart import BarChart
chart = BarChart()
chart.type = "col"          # "col"=纵向柱 / "bar"=横向条
chart.style = 10            # 0-48,内置样式
chart.title = "..."
chart.x_axis.title = "..."
chart.y_axis.title = "..."
chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=N), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=N))
ws.add_chart(chart, "H2")
```
- **适用**:分类数 ≤ 15、对比"谁高谁低"
- **坑**:>20 类难读;考虑 top-N + "其他" 合并

#### 折线图(时间趋势)
```python
from openpyxl.chart import LineChart
chart = LineChart()
chart.add_data(...)          # 同柱状图
chart.set_categories(...)
```
- **适用**:时间序列(X 轴是连续日期/月份)
- **坑**:X 轴类别列必须用整数或日期类型,**别用 float**;否则显示 `2015.0`

#### 面积图(强调累积)
```python
from openpyxl.chart import AreaChart
chart = AreaChart()
chart.grouping = "stacked"   # "stacked" / "percentStacked" / "standard"
```
- **适用**:趋势 + 累积感;不超 5 条系列

#### 饼图 / 环形图(占比)
```python
from openpyxl.chart import PieChart
# 或 DoughnutChart(环形)
```
- **适用**:占比,类别 ≤ 6(超过难读,改用柱状堆叠)
- **坑**:**慎用饼图**;很难精确比较两个相近扇形角度

#### 散点图(相关性 / 分布)
```python
from openpyxl.chart import ScatterChart, Reference, Series
chart = ScatterChart()
chart.style = 13
xvalues = Reference(ws, min_col=COL_X, min_row=2, max_row=N)
yvalues = Reference(ws, min_col=COL_Y, min_row=2, max_row=N)
series = Series(yvalues, xvalues, title_from_data=True)
chart.series.append(series)
```
- **适用**:两连续变量相关性;气泡图可加第三维(size)
- **坑**:**必须用 `ScatterChart`**,别用 `LineChart` 加散点样式代替

#### 双轴组合图(双量纲)
```python
from openpyxl.chart import BarChart, LineChart

primary = BarChart()              # 主图
primary.y_axis.crosses = "autoZero"
primary.y_axis.axId = 100         # 主 Y 轴 ID
primary.add_data(...)

secondary = LineChart()           # 副图
secondary.y_axis.axId = 200        # ★ 与主图 axId 不同
secondary.y_axis.crosses = "max"  # ★ 副图 Y 轴从右边起
secondary.add_data(...)

primary += secondary              # 组合
ws.add_chart(primary, "H2")
```
- **适用**:左轴金额、右轴比率/数量,共用 X 轴
- **坑**:`y_axis.axId` 必须不同(否则只显示一边);`crosses="max"` 让副 Y 轴在右

#### 100% 堆叠柱(占比随时间变化)
```python
chart = BarChart()
chart.grouping = "percentStacked"
chart.overlap = 100              # ★ 必须,否则系列不堆叠
```
- **适用**:展示占比结构在时间维度上的演变

#### 雷达图(多维对比)
```python
from openpyxl.chart import RadarChart
chart = RadarChart()
chart.type = "filled"             # 或 "marker" / "standard"
```
- **适用**:同一对象多维属性对比,维度 3-8 个
- **坑**:维度太多(>10)线条糊在一起

## 样式规范

- 表头:加粗 + 居中 + 底色(light blue,语义"primary") + 边框
- 数据行:左对齐 + 边框
- 公式列:右对齐(具体 `number_format` 字符串见下文"openpyxl / pandas 工具运行查询"章节速查,或 LLM 按数据形态选)
- 中文:runtime 已装 `fonts-noto-cjk`(见 Dockerfile),不需额外处理

## openpyxl / pandas 工具运行查询

LLM 写 Python 时不确定某个类 / 参数 / 语法,**不要瞎猜**,用 bash 工具查真实文档:

```bash
# openpyxl 任意类
python3 -c "from openpyxl.chart import BarChart; help(BarChart)"
python3 -c "from openpyxl.formatting.rule import ColorScaleRule; help(ColorScaleRule)"

# pandas
python3 -c "import pandas; help(pandas.read_excel)"
python3 -c "import pandas; help(pandas.DataFrame.merge)"

# 看类继承 + 方法签名
python3 -c "from openpyxl.chart import BarChart; print(BarChart.__mro__); print(dir(BarChart))"

# 查特定函数的参数
python3 -c "from openpyxl.formatting.rule import ColorScaleRule; import inspect; print(inspect.signature(ColorScaleRule.__init__))"
```

网络可达时,可直接 web fetch 官方文档:
- openpyxl: https://openpyxl.readthedocs.io/en/stable/
- pandas: https://pandas.pydata.org/docs/

**常用 `number_format` 字符串**(openpyxl / Excel 通用,速查;不是规定):

| 用途 | 格式字符串 |
|---|---|
| 百分比 | `0.00%` |
| 金额 | `#,##0.00` |
| 整数 | `#,##0` |
| 日期 | `yyyy-mm-dd` |
| 比率 | `0.00` |

## 常见坑

| 坑 | 解决 |
|---|---|
| 公式写入后值不显示 | openpyxl 写入只存公式字符串,Excel 打开时重算;不要 `data_only=True` 读(会丢公式) |
| 中文字符乱码 | openpyxl 写中文无问题,字体已装 |
| 图表 X 轴年份显示为 `2015.0` | categories 列用整数,源数据别转 float |
| 图表数据范围不够 | Reference 用 `min_col, max_col, min_row-1, max_row` 含表头 |
| 双轴只显示一边 | 副图必须 `y_axis.axId` 与主图不同,并 `crosses="max"` |
| 大文件很慢 | `openpyxl.load_workbook(..., read_only=True)` 只读模式 |

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