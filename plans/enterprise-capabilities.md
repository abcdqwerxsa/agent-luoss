# 企业能力增强：MCP / Skills 统一管理（部门/角色分配）+ 用量统计完善

> 决策已确认：stdio/http/sse 全支持、密钥 cryptx 加密、不做 OAuth；Skills zip 上传、按部门/角色分配；本期不做内置工具管理；用量统计 a–f 全要；新建独立 caps 服务。

## Context

平台（对标 WorkBuddy，单企业部署、不做多租户）当前缺口：

1. **能力扩展零管理**：agent-runtime 的 ResourceLoader 是最小实现（`loader.ts` 无 skills/extensions/MCP）。管理员无法接入 MCP 服务器、企业技能库，更无法按部门/角色控制可见性。
2. **用量统计维度不足**：仅 per-user/day 聚合（`usage.usage_daily`），原始事件表 `usage_events` 已有 provider/model/cache 维度但没有任何聚合展示；无任务级消耗、模型维度、排行、导出。

### 已验证的 pi SDK 注入点
- **MCP**：官方扩展 `pi-mcp-adapter`（v2.34），`createMcpAdapter({ config: { mcpServers } })` 返回 extension，**内存态隔离配置**（不读写文件），支持 stdio(command/args/env) 与 url(http/sse)。代理工具模式省 context。
- **Skills**：`ResourceLoader.getSkills()` 返回 `Skill[]`（`{name, description, filePath, baseDir, source:"custom"}`），pi 按需从 filePath 读内容。
- **工具白名单**：`createAgentSession({ tools })` 是白名单——**必须把 adapter 注册的工具名追加进去**，否则 MCP 工具不可见（sdk.md L611）。

### 关键技术风险（已核实）
`pi-mcp-adapter` 主入口是纯 TypeScript 源码（`exports["."]="./index.ts"`）。agent-runtime 现为 `tsc → node dist/index.js`，Node 无法直接加载 .ts。**解决**：启动改为 `node --import tsx dist/index.js`（tsx 能转译 node_modules 内的 .ts，即 adapter 文档推荐方式）。

### 设计决策（本次确认/自主裁定）
- 新服务 **caps**（:9096），proto `caps.proto`，目录 `internal/caps` + `cmd/caps`。
- **IAM 引入部门**：`departments` 表 + `users.department_id`（单部门，可空）。角色沿用 admin/member。
- **统一 scope 模型**（MCP 与 Skills 共用同一机制）：每条能力可设多个 scope，`type ∈ {all, department, role}` + `value`；空 scope 列表 = 仅管理员可见不可用？否——**空 = 平台全员可用**（最宽松默认，与"all"等价简化：scope 表无记录即全员）。
- **生效时机**：每次 CreateSession（新建 + 故障恢复重建）时 task 服务实时调 `caps.GetEffectiveCaps(userId)`。管理员改动只影响新会话，旧会话靠空闲驱逐自然过期。不落库快照（避免密钥进 task 表）。
- **用量统计零 schema 变更**：模型维度/任务级/cache 全部从 `usage_events` 现查（字段全有），只补两个索引。`usage_daily` 维持现状供快速图表。
- MCP env 密钥：cryptx AES-GCM 加密存储（同 modelmgt Key 模式），仅 GetEffectiveCaps 内部调用时解密，REST 列表接口不回明文。

## Files to modify / create

### 新建
| 文件 | 内容 |
|---|---|
| `proto/caps.proto` | MCP/Skill CRUD + GetEffectiveCaps（见下） |
| `internal/caps/{server.go,store.go}` | 服务实现 |
| `internal/caps/migrations/caps.sql` | `mcp_servers`, `skills`, `cap_scopes` 三表 |
| `cmd/caps/main.go` | 入口（:9096，参照 cmd/modelmgt/main.go） |
| `internal/gateway/caps.go` | REST：/admin/mcp、/admin/skills（含 zip 上传）、/admin/departments |
| `services/agent-runtime/src/caps.ts` | caps 类型 + createMcpAdapter 封装 + Skill 构造 |
| `deploy/e2e-caps.mjs` 或扩展 `deploy/e2e.mjs` | 断言新链路 |

### 修改
| 文件 | 改动 |
|---|---|
| `proto/iam.proto` | +`GetUser`(by id，含 department)、部门 CRUD RPC |
| `internal/iam/{store.go,server.go}` + migrations | departments 表、users.department_id、上述 RPC |
| `proto/task.proto`、`proto/runtime.proto` | CreateSessionRequest 增 `mcp_servers[]`/`skills[]`；task 侧透传 |
| `internal/task/server.go`、`cmd/task/main.go` | CreateTask/重建会话时调 caps.GetEffectiveCaps，结果随 CreateSession 下发 |
| `services/agent-runtime/src/{loader.ts,pool.ts,index.ts,package.json}` | loader 注入 extensions/skills；tools 白名单追加 MCP 工具名；`tsx` 启动；依赖 +`pi-mcp-adapter` |
| `proto/usage.proto`、`internal/usage/{server.go,migrations}` | GetUsageSummary 扩展 by_model/top_users/cache + 时间范围；新 GetTaskUsage；索引 `usage_events(task_id)`、`(ts,user_id)` |
| `internal/gateway/{usage.go,task.go}` | 汇总接口扩展、`/tasks/:id/usage`、CSV 导出端点 |
| `web/src/lib/api.ts`、`web/src/pages/{Admin.tsx,TaskDetail.tsx}` | 部门/MCP/Skills 三个新 tab；用量页升级；任务详情用量卡 |
| `deploy/docker-compose{,.standard}.yml`、runtime Dockerfile | caps 服务 + `/data/skills` 共享卷（caps 写、runtime 读）+ tsx |
| `README.md`、`AGENTS.md` | 架构图/命令/约定更新 |

### proto 要点
```protobuf
// caps.proto（节选）
message McpServerDef { string id=1; string name=2; string transport=3; /*stdio|http|sse*/
  string command=4; repeated string args=5; map<string,string> env=6; string url=7; bool enabled=8; }
message SkillDef { string id=1; string name=2; string description=3; string path=4; bool enabled=5; }
message Scope { string type=1; /*all|department|role*/ string value=2; }
// GetEffectiveCaps(userId) → { repeated McpServerDef mcp_servers(env已解密); repeated SkillDef skills; }
```

### 表
```sql
caps.mcp_servers(id PK, name UNIQUE, transport, command, args JSONB, env JSONB /*值加密*/, url, enabled, updated_at)
caps.skills(id PK, name UNIQUE, description, path /* /data/skills/<id> */, enabled, updated_at)
caps.cap_scopes(cap_type /*mcp|skill*/, cap_id, type, value, PRIMARY KEY(cap_type,cap_id,type,value))
iam.departments(id PK, name UNIQUE); ALTER iam.users ADD department_id TEXT REFERENCES iam.departments(id);
CREATE INDEX ON usage.usage_events(task_id); CREATE INDEX ON usage.usage_events(ts, user_id);
```

## Reuse（现有可复用）
- **modelmgt 全套模式**：admin CRUD + cryptx 加解密 + 渲染/通知 → caps 照抄 CRUD 与加密部分（分发改为按会话 gRPC 下发，不渲染全局 JSON——因 scope 因人而异）
- `internal/gateway/server.go` 的 `x-user-role` metadata → caps `adminOnly` 鉴权（同 usage/server.go:47）
- artifact 的 zip 解压 + `..`/symlink 防逃逸（有单测 `internal/artifact`）→ skills 上传复用
- `internal/auditx.Publish` → 新审计动作（caps.mcp_upsert / caps.skill_upsert / iam.dept_* 等）
- web Admin.tsx 的 tab/表单模式 → 三个新 tab 照现有 Users/Models 风格写

## Steps

- [x] 1. proto：新增 caps.proto；iam.proto 加部门 CRUD + GetUser；runtime.proto CreateSessionRequest 加 mcp_servers/skills；usage.proto 扩展。`make proto`
- [x] 2. iam：migrations（departments、users.department_id）+ store/server 实现 + 单测（部门 CRUD、GetUser）
- [x] 3. caps 服务：migrations、store（CRUD + scope）、server（adminOnly 鉴权、cryptx 加解密 env、GetEffectiveCaps 调 iam.GetUser 后按 scope 过滤）、zip 上传解压到 /data/skills（防逃逸断言）+ 单测（scope 过滤矩阵：all/dept/role/组合）
- [x] 4. task 接线：main.go 拨 caps；CreateTask 与会话重建路径调 GetEffectiveCaps 并透传给 runtime（proto-loader camelCase 注意）
- [x] 5. agent-runtime：`npm i pi-mcp-adapter tsx`；start 改 `node --import tsx dist/index.js`；caps.ts 封装 createMcpAdapter + Skill 构造；loader.getExtensions/getSkills 注入；tools = TOOLS[mode] + adapter 工具名；`npm run build` 过 + 冒烟脚本（用一个最小 stdio echo MCP server 验证工具可调）
- [x] 6. usage：索引迁移；GetUsageSummary 扩展（days/from/to、by_model、top_users、cache 列）；GetTaskUsage；gateway 端点 + CSV 导出（`text/csv`，admin）
- [x] 7. web：api.ts 新端点；Admin.tsx 加 部门/MCP/Skills 三 tab（MCP 表单含 transport 切换 stdio/url、env 键值对编辑、scope 多选；Skills zip 上传 + 列表 + scope）；UsersTab 加部门下拉；UsageTab 升级（范围选择 7/30/90、模型维度表、Top 用户、cache 列、导出按钮）；TaskDetail 用量卡
- [x] 8. deploy：两个 compose 加 caps（9096）+ /data/skills 卷；runtime Dockerfile 适配 tsx；e2e 断言（建部门→建用户挂部门→配 MCP(stdio echo)+Skill(带 dept scope)→建任务→事件流出现 mcp 工具调用→usage 各维度有数）
- [x] 9. 文档：README 架构图/快速开始；AGENTS.md 目录约定（caps、/data/skills）

## Verification
1. `make build && make test`（iam/caps 单测通过）
2. compose 起全栈：管理员建部门 D1、用户 U1∈D1；配 stdio echo MCP server（scope=D1）+ Skill A（scope=all）+ Skill B（scope=role:admin）
3. U1 建任务：会话能调 MCP echo 工具、Skill A 可见、Skill B 不可见；U1 无 dept 时不生效的 scope 验证一条
4. 用量：跑几轮对话后，Admin 用量页模型维度/Top 用户/cache 列/30 天范围正确；任务详情显示本任务累计 tokens/费用；CSV 下载内容与页面一致
5. 密钥安全：REST ListMcpServers 不返回 env 明文；PG 中 env 为密文
6. 回归：`deploy/e2e.mjs` 原有 14 项断言全过

## 风险与回退
- pi-mcp-adapter 纯 TS 源 → tsx 运行时加载。若 tsx 在容器内有问题，回退方案：`npm run build:public` 深链 dist（适配性差）或自写最小 MCP 客户端（@modelcontextprotocol/sdk + pi.registerTool）。冒烟脚本第 5 步先行验证。
- 会话重建时 caps 实时解析，caps 服务宕机 → fail-open（返回空 caps，任务仍可跑，仅无扩展能力），同 usage 配额 fail-open 哲学。
