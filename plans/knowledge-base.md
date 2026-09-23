# 知识库能力（Agentic RAG）实施计划

> 状态：决策齐备，待批准执行

## Context

平台需要企业级知识库能力（复杂 RAG 场景）。已确认的架构与决策：

- **检索智能在 agent 循环**：KB 工具 = 够好的单发检索，agent 多轮调用 + 读原文兜底复杂问题；GraphRAG/蒸馏层后置
- **嵌入暂不接**，但保留自定义接入位（env + schema 预留），端点就绪后插上即用
- **解析器选 MinerU**（主）——PDF/DOCX/PPTX/XLSX/图片全格式、中文扫描件 OCR（PP-OCRv6）、表格→HTML、官方 FastAPI 模式（`/file_parse` multipart）；OpenDataLoader-PDF 作为数字 PDF 加速通道（可选，Phase 3）
- **按部门分库**：每库 = 一条 caps MCP 记录（`http://kb:9097/mcp/<kbId>`），可见性直接复用 caps 部门/角色/全员作用域，治理零新代码；每会话只注入可见库工具
- **部门内用户可上传**：kb 服务经 iam 客户端校验上传者部门 ∈ 库作用域（复用 caps 的 GetUser 模式）；管理员直通
- 语料：几千篇、全格式、中文为主 → 解析质量主导检索质量，异步入库（状态机）

## 架构

```
Admin/部门用户 ──multipart──► gateway ──gRPC──► kb (:9097)
                                              ├─ PG kb.* (docs/chunks, trigram)
                                              ├─ parse worker (ticker 扫 status=pending)
                                              │    ├─ md/txt/csv: builtin 直读
                                              │    └─ 其余: POST MINERU_URL/file_parse → markdown
                                              └─ MCP http server /mcp/<kbId> → search / read_doc
task-svc 建会话 ──► caps GetEffectiveCaps ──► 注入该用户可见库的 MCP 工具
agent 循环: search → (不够) read_doc 深读 → 引用 [doc:xx]
```

## 复用清单

| 复用 | 来源 |
|---|---|
| 作用域解析 | `internal/caps/server.go` GetEffectiveCaps + Scope{all/department/role} |
| caps 联动注册 | kb 调 `UpsertMcpServer`（transport=http, url=/mcp/<kbId>） |
| multipart 上传模式 | `internal/gateway/caps.go` uploadSkill |
| iam 部门校验模式 | `internal/caps/server.go` 的 iam client 用法 |
| 服务骨架 | `cmd/*/main.go` + `internal/grpcx` + `internal/db`（内嵌迁移）+ metricsx |
| 异步状态机 | 看门狗模式：status 列 + ticker 扫描（`internal/task/watchdog.go`） |
| 引用呈现 | generative UI spec 流（来源卡） |
| 计量 | `reportToolCall`（kb 工具自动进用量） |

## 分期

### Phase 0 — 地基闭环（~2-3 天）
- [x] `proto/kb.proto`：CreateKB(name, scope)/DeleteKB/ListKBs；UploadDoc/DeleteDoc/ListDocs(status)；Search(kbId, query, topK)；ReadDoc(docId, section)
- [x] `internal/kb`（server/store/parse/mcp.go）+ `cmd/kb/main.go` + `kb.sql`（kbs/docs/chunks + pg_trgm GIN 索引，**不动 PG 镜像**）
- [x] builtin 解析（md/txt/csv）+ markdown 感知分块（标题边界 ~512 token）+ trigram 检索（`%word%`+similarity 混合排序）
- [x] MCP http server `/mcp/<kbId>`：`search(query, top_k?) -> [{doc_id, title, section, score, snippet}]`、`read_doc(doc_id, section?) -> markdown`
- [x] caps 联动：CreateKB/DeleteKB 自动 Upsert/DeleteMcpServer
- [x] gateway：`/api/v1/admin/kb/*`（建库/删库/列表/文档管理）+ `/api/v1/kb/:id/docs`（部门用户上传，iam 校验）
- [x] web：Admin KnowledgeTab（库列表+作用域+文档列表+状态+上传）；任务会话页工具调用已有展示（kb 自动出现）
- [x] ingest 状态机：docs.status = parsing/ready/failed + error 信息；worker ticker
- [x] 单测：分块器（标题边界/表格保整）、trigram 排序纯函数；冒烟 `deploy/smoke-kb.mjs`（建库→传 md→MCP search 断言）

### Phase 1 — MinerU 接入 + 体验补全（~2 天）
- [x] compose 增 MinerU 服务（CPU 起步；镜像走 `REG` 前缀，daocloud 无则换源——部署风险点）
- [x] parse worker 对非 md/txt/csv 一律走 `POST {MINERU_URL}/file_parse`（multipart，返回 markdown/JSON）；超时/重试/失败落 status
- [x] 分块升级：MinerU markdown 的标题层级 + HTML 表格整块保留（表格是中文企业文档检索关键）
- [x] 批量导入 CLI（`deploy/kb-import.mjs`：目录→并发上传，几千篇灌库）
- [x] 来源卡：聊天里 `[doc:xx]` → generative UI 渲染（文档名+段落+跳转）
- [x] 评测基座 v1：`deploy/kb-eval.mjs` golden set（每库 ≥20 真实问题+期望 doc）→ recall@5 / MRR；先量 lexical 基线

### Phase 2 — 语义层（嵌入端点就绪后，~2 天）
- [ ] PG 镜像换 `pgvector/pgvector:pg17`（同大版本，pgdata 兼容；`CREATE EXTENSION vector`）+ chunks 加 embedding 列（NULL 允许）
- [ ] `KB_EMBED_BASE_URL/MODEL/KEY/DIMS` env + 入库批量嵌入 + 查询侧嵌入
- [ ] hybrid 排序（vector + trigram，RRF 融合，权重 env 可调）；eval 对比 lexical vs hybrid，数据说话
- [ ] 重索引命令（换嵌入模型时全量回填）

### Phase 3 — 复杂场景强化（评测驱动，逐项独立）
- 蒸馏层：入库时弱模型（Jev 弱档）生成摘要/FAQ 页入索引（LLM-wiki 定位）
- 多库联邦工具 `federate_search`（一次查全部可见库）
- rerank 端点接入（eval 证明 hybrid 不够才上）
- OpenDataLoader-PDF 加速通道（数字 PDF 走它，扫描走 MinerU）
- 表格检索增强（表格→结构化摘要行）

### Phase 4 — 可选（明确触发才做）
- 图检索工具（实体索引）：触发 = eval 显示实体多跳是主要失败模式
- Confluence/共享盘连接器、定时重同步
- 文档级 ACL、上传配额

## Files to modify

新增：`proto/kb.proto`、`internal/kb/{server,store,parse,mcp}.go`、`internal/kb/migrations/kb.sql`、`cmd/kb/main.go`、`deploy/smoke-kb.mjs`
修改：`internal/gateway/kb.go`（新）、`internal/gateway/server.go`（挂路由+KB_ADDR）、`web/src/pages/Admin.tsx`（KnowledgeTab）、`web/src/lib/api.ts`、两个 compose（kb 服务；Phase 1 加 MinerU）、`deploy/Dockerfile.gosvc` 或独立 `Dockerfile.kb`（如需 python 侧依赖——builtin 无需）
联动：kb → caps gRPC 客户端（UpsertMcpServer 自动注册）

## Verification

1. Phase 0：`go build/vet/test` 全绿；smoke-kb.mjs 通过（建库→上传→search 命中→read_doc 返回原文→caps 记录生成→新会话 agent 能调工具）
2. 权限：非本部门用户上传被拒（403）；非作用域用户会话看不到该库工具
3. Phase 1：上传一份扫描 PDF → status parsing→ready → search 中文关键词命中；kb-eval 输出 recall@5 基线
4. 部署：compose 起栈 → 容器内 `curl kb:9097` 健康；管理页建库传文档 → 普通会话问知识问题 → SSE 见 kb 工具调用与引用
