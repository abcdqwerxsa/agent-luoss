# 企业级管理后台：用量/审计去假存真 + 统计维度扩展

## Context（现状与问题实证）

用户反馈"用量和审计存在假数据、管理后台功能太少、统计维度不够"。代码与**服务器真实数据**核查结论：

**链路本身是通的，问题出在数据与管理闭环：**

1. **cost_usd 全部为 0（"假数据"的直接来源）**
   - 服务器 `usage.usage_events` 134 条真实事件，tokens 真实，`sum(cost_usd) = 0.000000`
   - 根因：`modelmgt.models` 里 4 个模型的 `input_cost/output_cost` **全是 0**——管理后台模型表单有价格输入框（`Admin.tsx:333-334`），但管理员配置时没填，默认 0
   - 计费链路：管理员填价格 → modelmgt 渲染 models.json（含 cost）→ pi 按价格算 cost.total → runtime 事件 message_end → task.reportUsage（`internal/task/server.go:593`）→ usage.ReportUsage 落库。**链路无 bug，纯数据缺失**
   - 但 UI 无任何"未定价"提示，$0.0000 展示出来就像假数据

2. **审计功能不完善**
   - 后端 `ListAuditLogs` 已支持 actor/action/from/to 过滤（`internal/usage/server.go`），**前端只用了 action 一个**
   - 前端动作下拉（`Admin.tsx AuditTab`）缺失已存在的 action：`caps.expert_upsert/expert_delete`、`caps.skill_update`、`model.upsert_provider`、`model.delete_provider/model`、`caps.mcp_*` 等
   - 无分页（后端 limit≤500）、无导出、无 actor/资源关键字搜索

3. **统计维度少（企业级差距）**
   - 现有：user/day 曲线、by_model、top_users（3 个维度）
   - 缺失：部门维度、专家维度（哪个专家最火/最烧钱）、活跃用户（DAU/WAU/MAU）、高消耗任务 Top N、任务级明细入口
   - 配额管理：后端 `PUT /admin/quota` + `api.admin.setQuota` 前端 API 已存在，**Users 页无配额编辑入口**——配额功能实际不可用

## Approach

分两批交付（P0 修真+管理闭环，P1 维度扩展），全部基于现有表和服务扩展，不加新微服务。

### P0：把"假"变真 + 管理闭环

1. **价格治理**
   - 用量页/模型页：价格为 0 的模型显示「未定价」徽标而非 $0.0000；用量页顶部加未定价模型警示条（列出模型名，提示管理员去模型页补价格）
   - 模型编辑表单：价格输入框加说明文案（$/1M tokens，0 = 不计成本）
   - （运营动作，非代码）给服务器现有 4 个模型补真实价格
2. **配额管理 UI**
   - Users 表加「月度配额」列：显示已用/限额，行内编辑（复用 `api.admin.setQuota`，`Admin.tsx` Users 表已有 Select 行内编辑模式可照抄）
   - 用量页"本月个人额度"卡片保留
3. **审计补全**
   - 动作下拉改为**后端动态获取**（`SELECT DISTINCT action` 新端点）或补全静态列表（加 expert/skill_update/provider 等）——倾向静态补全，一次列表维护即可
   - 加 actor 搜索框、时间范围选择、resource 关键字过滤（后端已支持 from/to/actor；resource 关键字需加 `detail/resource ILIKE`）
   - 分页（limit/offset，后端加 offset）+ 导出 CSV（照抄 usageExport 模式）

### P1：统计维度扩展

4. **专家维度**（核心卖点：哪个专家最受欢迎、最烧钱）
   - `usage_events` 加 `expert_id TEXT DEFAULT ''` 列 + 索引（migration）
   - proto `ReportUsageRequest` 加 expert_id；task.reportUsage 从 task 行取 expert_id 传入
   - `GetUsageSummary` 加 `by_expert` 聚合；usage_daily 不动（按事件表聚合）
   - 前端用量页加「专家消耗 Top N」表
5. **部门维度**
   - `GetUsageSummary` 加 `by_department`：usage_daily JOIN iam.users（取 department_id）JOIN iam.departments（取名称）。单库跨 schema join，不引入 gRPC 往返
   - 前端加「部门消耗」表 + 管理员可按部门筛选（user filter 扩展）
6. **活跃用户**
   - DAU/WAU/MAU 三卡片（usage_daily 按 (day,user_id) distinct count）+ 新用户数（首次出现日）
7. **高消耗任务 Top N**
   - usage_events GROUP BY task_id ORDER BY cost DESC LIMIT 20，JOIN task.tasks 取标题/用户
   - 前端表格 + 点击跳转任务详情
8. **CSV 导出扩展**
   - 现有导出仅 user/day；加部门/专家维度导出参数

### 不做（本期明确排除，防止范围膨胀）
- 工具调用统计（需事件落库 + 新表，工程量大，单独排期）
- 审计保留策略/自动清理（数据量小，YAGNI）
- 模型价格预填库（价格随市场变动，人工维护即可；若用户要可加）

## Files to modify

| 文件 | 改动 |
|---|---|
| `internal/usage/migrations/usage.sql` | usage_events 加 expert_id 列 + 索引（新 migration 段，幂等） |
| `proto/usage.proto` | ReportUsageRequest.expert_id；GetUsageSummaryResponse 加 by_expert/by_department/by_task/dau/wau/mau |
| `proto/modelmgt.proto` | 不动（价格字段已有） |
| `internal/usage/server.go` | ReportUsage 写 expert_id；GetUsageSummary 四个新聚合查询；ListAuditLogs 加 resource 关键字 + offset 分页；新 AuditActions 端点（若选动态） |
| `internal/task/server.go` | reportUsage 取 t.ExpertID 传入 |
| `internal/task/usage_adapter.go` | Report 传 expert_id |
| `internal/gateway/usage.go` | audit 路由透传新参数；audit export CSV；usage export 扩展维度参数 |
| `web/src/pages/Admin.tsx` | UsageTab：未定价警示、DAU/WAU/MAU 卡片、专家/部门/高耗任务/工具调用表；AuditTab：过滤+分页+导出；UsersTab：配额列+行内编辑；ModelsTab：「未定价」徽标 |
| `web/src/lib/api.ts` | 新字段/端点类型 |

## Reuse（已确认存在的可复用件）

- `api.admin.setQuota`（api.ts:125）+ `PUT /admin/quota`（gateway usage.go:140）——配额 UI 只差前端
- `usageExport` CSV 模式（gateway usage.go:64-84）——审计导出照抄
- Users 表 Select 行内编辑模式（Admin.tsx:87+）——配额编辑照抄
- ListAuditLogs 后端已支持 actor/from/to（usage/server.go）——前端接线即可
- `chart-plot`/dayList 聚合模式（Admin.tsx:635+）——新维度表格复用卡片样式
- iam schema 同库可直接 JOIN（PG 单库，usage↔iam↔task 跨 schema 已有先例：无。但单库 JOIN 是 PG 常规操作，usage 服务持全库连接池）

## Steps

- [x] 1. migration：usage_events.expert_id + proto 扩展（usage.proto 四个新聚合字段）
- [x] 2. usage 服务：ReportUsage 落 expert_id；四个新聚合 SQL（by_expert/by_department/by_task/DAU-WAU-MAU）
- [x] 3. task 服务：reportUsage 传 expert_id
- [x] 4. gateway：审计过滤参数透传 + resource ILIKE + offset 分页 + 审计 CSV 导出 + usage export 维度参数
- [x] 5. 前端 UsageTab：未定价警示条 + DAU/WAU/MAU 卡片 + 专家/部门/高耗任务三表
- [x] 6. 前端 AuditTab：补全 action 下拉 + actor/resource/时间过滤 + 分页 + 导出
- [x] 7. 前端 UsersTab：配额列行内编辑；ModelsTab：未定价徽标
- [ ] 8. 服务器运营：为现有 4 模型补真实价格（sensenova×3、deepseek、kimi）
- [ ] 9. 部署验证（e2e 断言扩展 + 真实任务后看新维度出数）

## Verification

1. `make build && make test`（proto 改动后 `make proto`）
2. 本地/服务器跑一个真实任务 → 验证 usage_events.expert_id 有值、cost > 0（补价格后）
3. 管理后台：用量页四新维度出数；审计页过滤/分页/导出可用；用户页配额可编辑并生效（超额任务被拦）
4. e2e.mjs 加断言：by_expert 非空、audit 过滤返回正确

## 待用户确认的决策点（见提问）

1. 价格预填库要不要（本期排除项）
2. P0/P1 一起做还是先 P0
3. 工具调用统计是否单独立项
