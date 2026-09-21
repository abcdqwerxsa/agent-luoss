# excel-master 技能包

> Excel 解析 / 生成 / 修改 / 图表专家技能,作为平台内置"专家(excel-master)"的内容载体。

## 包结构

```
excel-master/
├── SKILL.md                # 技能正文(frontmatter + playbook)
├── README.md               # 本文件
├── tools/
│   ├── excel_inspect.py    # 解析:JSON 输出 sheets/headers/公式/图表
│   ├── excel_build.py      # 生成/修改:从 JSON spec 写 xlsx + 公式 + 样式
│   ├── excel_chart.py      # 图表:在已有 xlsx 上加柱/折线/面积/双轴
│   └── excel_summary.py    # 抽取数字辅助写总结
└── sample_data/
    ├── cross_border_ecom.json        # MVP 场景的 build spec
    └── cross_border_ecom.charts.json # MVP 场景的 chart spec
```

## 管理员安装步骤

1. 把整个 `skills/excel-master/` 目录打包成 zip(`zip -r excel-master.zip excel-master/`)。**注意 zip 根**:`SKILL.md` 必须在 zip 根目录或单层子目录里(caps 会自动识别)。
2. 登录管理后台 → **Skills** → **上传** → 选 zip → 设 scopes(可全空 = 全员可见)→ 提交。
3. 切到 **专家** → **添加** → id 填 `excel-master`,名称 `Excel 专家`,绑定刚上传的 skill,scope 选全员 → 提交。
4. 普通用户在 `http://gateway:8080/#/experts` 即可看到 "Excel 专家" 卡片。

## 用户使用方式

1. 用户登录 → **专家** 页 → 点 **Excel 专家** 卡片 → 进入任务页。
2. 在聊天框输入需求,如:
   > "帮我整理 2015–2025 中国跨境电商交易额与出口占比的趋势,生成 Excel,含双轴图"
3. 模型加载技能后,按 SKILL.md 的工作流推进:inspect → 规划 spec → build → chart → summary。
4. 任务结束后用户从 workspace 下载 .xlsx 文件,Excel 打开后图表完整显示(Excel 重算公式)。

## 开发者扩展**:新场景

要加新场景只需:
1. 新建 `sample_data/<场景名>.json` 和 `<场景名>.charts.json`
2. 在 SKILL.md 的"MVP 场景"段落下加 `<场景名>工作流` 小节
3. 如需新能力(如透视),加 `tools/excel_<能力>.py` 并在 SKILL.md 的工具表登记

**无需改动**:proto / caps / task / runtime / web 任何代码。

## 依赖

- Python 3.10+(runtime 镜像已含 `python3` + `python3-pip`)
- `openpyxl >= 3.1`(读/写/公式/图表主力)
- `pandas >= 2.0`(可选,辅助数据转换)

镜像装包见 `deploy/Dockerfile.runtime`。