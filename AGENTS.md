# AgentLuoss — 项目说明

企业通用智能体 Web 微服务平台：pi 开源 Agent 内核（Node sidecar）+ Golang 微服务。
能力对标 WorkBuddy（任务对话/执行过程/产物/多模型/企业管控），**无沙箱隔离**（目录级：每用户一个工作区子目录）。

## 架构速览

```
web(React) → gateway(:8080, REST+SSE) ─gRPC→ iam/task/artifact/modelmgt/usage
task(:9092) ─gRPC→ agent-runtime×N(Node, pi SDK, 会话池+空闲驱逐+文件恢复)
modelmgt → 渲染 /data/config/models.json（pi 格式，API Key AES-GCM 加密存 PG）
```

- 事件流：runtime `PushEvents` → task（Redis Stream 序号 + fan-out）→ gateway SSE（Last-Event-ID 回放）
- 会话恢复：pi 会话文件在 `/data/sessions/<taskId>.jsonl`；runtime 失联/驱逐后 task 用 `SessionManager.open` 重建
- 三模式：ask（只读工具）/ craft（全工具）/ plan（先出计划、用户确认后执行）

## 常用命令

```bash
make build          # go build ./...
make proto          # protoc 重新生成 Go 代码（proto/ 变更后必须）
make test           # go test ./...
cd deploy && docker compose up -d   # 全栈（本机适配版，见下）
```

## 目录约定

- `proto/` gRPC 契约（改后跑 make proto；Node 端 proto-loader 动态加载不需生成）
- `internal/<svc>/` 服务实现；`internal/{jwtx,auditx,cryptx,db,grpcx}` 共享库
- `cmd/<svc>/main.go` 入口；改环境变量看各 main.go 顶部的 envOr
- `services/agent-runtime/` Node sidecar（`npm run build`；scripts/smoke*.mjs 冒烟）
- `web/` 前端（构建产物打进 Go 镜像 /app/web）
- `deploy/` compose/Dockerfile/e2e.mjs/load.mjs

## 开发注意事项

- proto-loader（Node 端）默认 camelCase：gRPC 消息字段在 TS/JS 里必须用 `taskId` 不是 `task_id`
- PG 时间戳取值统一 `(extract(epoch from col)*1000)::bigint`（pgx 不能直接扫 numeric 进 int64）
- artifact 路径校验：显式拒绝 `..`/绝对路径 + EvalSymlinks 前缀断言（有单测，改动先跑）
- 用量/配额 fail-open：usage 服务不可用时放行（不能因计量故障阻塞业务）
- 审计走 Redis Stream `audit`（auditx.Publish，fire-and-forget），usage 服务消费落库
- modelmgt 的 Key 只写不读；渲染时解密进 models.json（0600，runtime 侧 setRuntimeApiKey 显式注册）

## 部署

`deploy/docker-compose.yml` 为**本开发机适配版**（内核缺 iptables DNAT + 内嵌 DNS）：静态 IP 172.28.0.0/24、runtime host 网络、全容器清空代理 env。正常主机用 `deploy/docker-compose.standard.yml`（服务名 DNS + 发布 8080）。

管理员账号由 iam 首次启动 bootstrap（ADMIN_USERNAME/ADMIN_PASSWORD，默认 admin/admin12345）。
模型在管理后台配置（Provider = OpenAI 兼容网关 + Key）后即可建任务。
