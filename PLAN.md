# 企业通用智能体 Web 微服务平台（基于 pi + Go）

> 状态：完整方案（用户已确认全部关键决策）

## Context

在 pi 开源 agent（`@earendil-works/pi-coding-agent`）之上搭建企业级通用智能体 Web 微服务平台。pi 提供 Agent 内核（LLM 对话、工具调用、流式事件、会话持久化），平台负责企业集成：以「用户会话（Session）执行任务（Task）」的方式对外提供能力。整体对标腾讯 WorkBuddy（任务列表、任务对话、执行过程展示、产物交付、中断/继续、追问、多模型、企业管控）。

**已确认的决策：**

| 决策点 | 结论 |
|---|---|
| pi 集成方式 | **B：Node sidecar 服务**（常驻进程，用 pi SDK 承载多会话，gRPC 对 Go 暴露） |
| 前端 | 做（React） |
| 通信/部署 | 服务间 gRPC；Docker Compose 起步（后续可迁 K8s） |
| 认证 | 内置账号体系（JWT）起步；RBAC、用量统计、审计日志 **必须做**；MCP、企业 Skill 管理 **暂不做** |
| 模型 | 平台统一管理；主力私有 OpenAI 兼容网关；测试可用线上模型 |
| 工作区 | **目录级隔离**：每用户一个子目录（非沙箱）；产物仅下载 |
| 并发目标 | 100~1000 活跃任务 |

## Approach

### 总体架构

```
┌─────────┐  HTTPS REST + SSE   ┌────────────┐
│  Web 前端 │◄──────────────────►│  gateway   │ (Go: JWT校验/限流/路由/SSE代理)
│ (React)  │                     └─────┬──────┘
└─────────┘                           │ gRPC
        ┌──────────┬──────────┬───────┼──────────┬──────────┐
        ▼          ▼          ▼       ▼          ▼          ▼
      iam        task      artifact  modelmgt   usage   agent-runtime
      (Go)       (Go)       (Go)     (Go)       (Go)     (Node/TS ×N)
   账号/RBAC/   任务编排(核心) 工作区文件  模型注册/   用量/配额/  pi SDK 会话池
   JWT签发      调度/事件流   上传下载    密钥/下发    审计消费      (每会话一个
                                                                     AgentSession)
                                                                  │ cwd=/data/workspaces/<userId>
                                                                  │ sessions=/data/sessions/<taskId>.jsonl
                                                                  ▼
                                                        LLM（私有 OpenAI 兼容网关，
                                                          由 modelmgt 渲染 models.json）

基础设施：PostgreSQL（各服务独立 schema）+ Redis（注册表/事件流/锁/审计流）
共享卷：/data/workspaces（用户目录，runtime 与 artifact 挂载）、/data/sessions
```

### 核心：agent-runtime（Node sidecar，pi SDK）

每个 `AgentSession` 绑定 `cwd=/data/workspaces/<userId>`，会话文件存 `/data/sessions/<taskId>.jsonl`（`SessionManager.create(cwd, customDir)`）。参考 SDK 示例 `12-full-control.ts` 的自定义 `ResourceLoader`：

- **三模式**（对标 WorkBuddy Ask/Craft/Plan）：每任务创建时固定
  - `ask`：只读工具白名单 `["read","ls","grep","find"]` + 问答型系统提示词
  - `craft`：全量默认工具 + 执行型提示词
  - `plan`：全量工具 + 「先输出计划、经用户确认消息后再执行」提示词（确认=前端再发一条 prompt，无需扩展）
- **会话池 + 空闲驱逐**：活跃会话常驻内存；空闲 >30min `dispose()`，下次 prompt 经 `SessionManager.open(path)` 从文件恢复 —— 支撑 1000 级任务而不需 1000 常驻内存会话
- **模型**：进程级 `ModelRuntime.create({authPath, modelsPath})`，models.json 由 modelmgt 渲染；`ReloadConfig` RPC 对**新会话**生效
- **进程级共享**：多个会话共用一个 ModelRuntime / Node 进程；水平扩容靠多副本

**gRPC 服务（proto 定义在仓库根 `proto/`）：**

```protobuf
service AgentRuntime {
  rpc CreateSession(CreateSessionRequest) returns (CreateSessionResponse);
  rpc Prompt(PromptRequest) returns (google.protobuf.Empty); // 事件走 PushEvents 流
  rpc Steer(SteerRequest) returns (google.protobuf.Empty);
  rpc Abort(AbortRequest) returns (google.protobuf.Empty);
  rpc GetSessionState(GetSessionStateRequest) returns (SessionStateResponse);
  rpc CloseSession(CloseSessionRequest) returns (google.protobuf.Empty);
  rpc Heartbeat(HeartbeatRequest) returns (HeartbeatResponse);   // 容量上报给 task
  rpc PushEvents(stream AgentEvent) returns (google.protobuf.Empty); // runtime→task
  rpc ReloadConfig(ReloadConfigRequest) returns (google.protobuf.Empty);
}
```

**pi 事件 → 平台事件映射**（SSE 载荷）：

| pi 事件 | 前端呈现 |
|---|---|
| `message_update`(text_delta/thinking_delta) | 对话流式文本 / 可折叠思考 |
| `tool_execution_start/update/end` | 工具执行卡片（命令、过程输出、结果、耗时） |
| `agent_start` / `agent_settled` | 任务状态 running/idle |
| `queue_update` | 追问排队提示 |
| `auto_retry_*` / `compaction_*` | 状态提示条 |
| message 的 `usage` 字段 | 用量上报（→usage 服务） |

### 核心：task 服务（Go，领域中枢）

- **任务生命周期**：`pending → running → idle → done/archived`；任务=pi 会话，元数据落 PG
- **runtime 调度**：runtime 心跳注册到 Redis（容量/负载）；`task→runtime` 分配记录在 DB，粘性；runtime 失联 → 重新分配 + 从会话文件恢复（`SessionManager.open`）；会话互斥用 Redis 锁 `lock:session:<taskId>`
- **事件管道**：runtime `PushEvents` → task-svc `XADD stream:task:<id>`（Redis Stream，即 SSE 回放日志，TTL 7d）→ 活跃订阅者 fan-out；SSE 断线用 `Last-Event-ID` 从 Stream 回放补齐
- **配额前置**：prompt 提交前调 usage 服务校验，超限拒绝

### 其余服务

- **iam**：用户/角色（admin/member）/JWT 签发与校验/RBAC 声明；REST：登录、用户 CRUD
- **artifact**：挂载 `/data/workspaces`，文件树/下载/上传（仅限本人目录，严格 path-traversal 校验，`filepath.EvalSymlinks` + 前缀断言）；对话图片上传转发给 runtime prompt `images`
- **modelmgt**：provider/model CRUD（PG），API Key AES-GCM 加密存储（主密钥来自环境变量）；渲染 models.json + auth.json 到共享配置卷并通知 runtime reload
- **usage**：消费用量事件与审计流（Redis Stream `stream:audit`，各服务审计拦截器生产），聚合日/月用量，配额查询与扣减接口；审计日志查询 API

### 安全边界说明（明确的天花板）

工作区为**目录级组织隔离**，非安全沙箱：runtime 容器内 bash 理论上可越出本人目录。v1 接受此风险（内部企业场景）。
`ponytail: 目录级隔离天花板，升级路径=每用户容器（K8s Pod/runtime class），接口已按 workspacePath 抽象，替换成本低。`

### 前端（React + Vite + TS）

- 页面：登录 / 任务列表（新建-选模式与模型、搜索、状态、继续）/ 任务详情（对话流 + 工具执行卡片 + 思考折叠、输入框发送/中止/追问、产物文件树 + 下载）/ 管理后台（用户、模型配置、用量看板、审计查询）
- SSE 用原生 `EventSource`（自动重连 + Last-Event-ID）

## Files to modify（新建，monorepo）

```
agent-luoss/
├── proto/                        # buf 管理；runtime.proto / task.proto / iam.proto / artifact.proto / modelmgt.proto / usage.proto
├── services/
│   ├── gateway/                  # cmd/main.go + internal/（REST 路由、JWT 中间件、SSE 代理、限流）
│   ├── iam/                      # cmd/main.go + internal/
│   ├── task/                     # cmd/main.go + internal/（调度器、事件管道、会话恢复）
│   ├── artifact/                 # cmd/main.go + internal/
│   ├── modelmgt/                 # cmd/main.go + internal/
│   ├── usage/                    # cmd/main.go + internal/（用量+审计）
│   └── agent-runtime/            # Node/TS：src/server.ts、sessionPool.ts、loaders.ts、events.ts、config.ts
├── internal/                     # Go 共享库（go.mod 单模块多 cmd）：jwtx/auditx/pgx/redisx/grpcx
├── web/                          # React 前端
├── deploy/
│   ├── docker-compose.yml        # postgres/redis/6 Go 服务/runtime×2/web
│   └── Dockerfile.go / Dockerfile.node / Dockerfile.web
└── buf.yaml / buf.gen.yaml / Makefile
```

## Reuse（复用清单）

- **pi SDK**：`createAgentSession` + 自定义 `ResourceLoader`（系统提示词/工具白名单）— 照 `examples/sdk/12-full-control.ts`；`SessionManager.create/open/inMemory` — 会话持久化与恢复（`examples/sdk/11-sessions.ts`）；`ModelRuntime.create({authPath, modelsPath})` + `setRuntimeApiKey`；`session.subscribe` 事件流；`session.prompt(text,{images,streamingBehavior})/steer()/followUp()/abort()`
- **pi 文档**：`docs/sdk.md`（选项全表）、`docs/custom-provider.md`（models.json 私有网关写法：`api:"openai-completions"` + `$ENV` key 引用）、`docs/rpc.md`（事件语义，事件映射参考）
- **Go 生态**：`gin`（gateway REST）、`grpc-go` + `buf` 代码生成、`jackc/pgx`、`redis/go-redis`、`golang-jwt/jwt`

## Steps

- [x] **S1 脚手架**：buf + proto 六个服务定义与代码生成；单 go.mod 多 cmd；Makefile（build/gen/up）；compose 起 postgres+redis；PG 各 schema 迁移文件
- [x] **S2 iam + gateway 骨架**：用户表/角色/JWT（access+refresh）；登录、用户 CRUD；gateway JWT 中间件与路由透传用户声明；审计拦截器（生产 `stream:audit`）
- [x] **S3 agent-runtime**：gRPC server；pi 集成（CreateSession 带模式/工具白名单/ResourceLoader）；Prompt/Steer/Abort/PushEvents；会话池 + 空闲驱逐 + 文件恢复；Heartbeat；本地用官方 API Key 冒烟（models.json 手写）
- [x] **S4 task 编排**：任务 CRUD；runtime 注册/心跳/粘性分配/失联重调度；事件管道（Redis Stream + 订阅 fan-out）；会话锁；配额前置接口（先直通）
- [x] **S5 gateway 任务 API + SSE**：`POST /tasks`、`GET /tasks/:id/events`(SSE, Last-Event-ID 回放)、`POST /tasks/:id/messages`、`POST /tasks/:id/abort`
- [x] **S6 artifact**：文件树/下载/上传 + 路径穿越防护；图片附件接入 prompt
- [x] **S7 modelmgt**：provider/model CRUD + Key 加密；models.json/auth.json 渲染下发 + runtime ReloadConfig
- [ ] **S8 usage**：用量事件消费与聚合（日/月）、配额与扣减、审计消费落库、用量/审计查询 API；接线 task 配额前置
- [ ] **S9 web 前端**：登录/任务列表/任务详情（SSE 流式渲染：文本增量、工具卡片、思考折叠、追问、中止）/产物面板/管理后台四页
- [ ] **S10 集成与验收**：compose 全栈 e2e；100 并发任务压测脚本；限流与安全加固

## Verification

1. **单测**：task 调度（分配/失联恢复/锁）、usage 聚合与配额、artifact 路径防护、JWT/RBAC 中间件
2. **runtime 冒烟**（S3 后即可）：手写 models.json + 线上 Key，grpcurl 发 CreateSession/Prompt，观察事件流
3. **e2e**（compose up 全栈）：登录 → 建任务（plan 模式）→ SSE 看到计划文本 → 发确认消息 → 工具执行卡片 → 产物下载 → 追问/中止 → 重启一个 runtime 副本验证会话恢复与重调度 → 断开 SSE 重连回放
4. **压测**：脚本并发创建 100 任务发 prompt，验证调度均衡、事件不丢（SSE 回放一致性）、runtime 内存（空闲驱逐生效）
5. **管控验证**：普通用户访问管理 API 被 RBAC 拒绝；超配额 prompt 被拒；审计表记录登录/建任务/改模型/下载操作
