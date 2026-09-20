# AgentLuoss

企业通用智能体 Web 微服务平台：基于 [pi](https://github.com/earendil-works/pi-mono) 开源 Agent 内核 + Golang 微服务，以「用户会话执行任务」的方式提供通用智能体能力。整体对标 WorkBuddy（任务列表 / 任务对话 / 执行过程 / 产物交付 / 中断继续 / 多模型 / 企业管控），**不做沙箱级工作区隔离**（目录级：每用户一个子目录）。

## 架构

```
Web (React) ──HTTPS/SSE──► gateway (Go :8080) ──gRPC──┬─► iam      (账号/RBAC/JWT)
                                                      ├─► task     (任务编排/调度/事件流)   ──gRPC──► agent-runtime ×N (Node, pi SDK)
                                                      ├─► artifact (工作区文件)                        │ cwd=/data/workspaces/<userId>
                                                      ├─► modelmgt (模型注册/密钥/models.json)          ▼
                                                      └─► usage    (用量/配额/审计)              LLM (私有 OpenAI 兼容网关)
```

- **agent-runtime**：Node sidecar，每任务一个 pi `AgentSession`；三模式（ask 只读 / craft 执行 / plan 先确认）；空闲会话驱逐 + 会话文件恢复；事件经 `PushEvents` 流回 task。
- **task**：核心编排。runtime 注册/心跳/最少负载调度/粘性分配/失联重调度；会话互斥锁；事件管道（Redis Stream 序号 + SSE Last-Event-ID 回放）。
- 工作区：`/data/workspaces/<userId>`（目录级隔离，无沙箱——升级路径为每用户容器）。

## 快速开始

```bash
cp .env.example .env   # 改 JWT_SECRET / KEY_MASTER
cd deploy && docker compose up -d
```

初始化管理员 `admin/admin12345`（环境变量可覆盖），登录 `gateway:8080`（浏览器需能路由到 compose 网络；本仓库开发者环境因宿主内核限制无端口发布，见下）。

配置模型：管理后台 → 模型 → 添加 Provider（OpenAI 兼容 base_url + API Key，AES-GCM 加密存储）→ 添加模型 → 自动渲染 models.json 并热加载到 runtime。

## 验收

```bash
# 容器网络内跑全栈 e2e（14 项断言）
docker run --rm --network agentluoss_backend -v $PWD:/w -w /w \
  -e ZAI_API_KEY=<key> -e http_proxy= -e https_proxy= \
  node:24-bookworm-slim node deploy/e2e.mjs http://172.28.0.11:8080

# 并发压测（100 并发任务）
... node deploy/load.mjs 100 http://172.28.0.11:8080
```

实测：e2e 14/14 PASS；100 并发任务 97/100 确认 settled（其余为 LLM 网关排队），双 runtime 调度均衡。

## 本开发机内核限制（compose 已适配）

本机 iptables DNAT 与 docker 内嵌 DNS 不可用，compose 做了对应处理，迁移到正常主机可还原为标准配置：

1. 不发布宿主端口；服务间用静态 IP（`172.28.0.0/24`）
2. runtime 用 `network_mode: host`（外网 LLM 调用需要宿主 DNS/出口）
3. 所有容器清空无效代理 env（`http_proxy=""` 等）

`ponytail: 内核限制适配在 compose 注释中标注，正常 K8s/compose 环境删掉静态 IP/host 网络即可。`

## 目录

```
proto/               六个服务的 gRPC 契约（Go 代码生成；Node 端 proto-loader 动态加载）
internal/<svc>/      Go 服务实现（iam/task/artifact/modelmgt/usage/gateway + jwtx/auditx/cryptx/db/grpcx）
cmd/<svc>/           服务入口
services/agent-runtime/  Node sidecar（pi SDK 会话池、模式预设、事件总线、冒烟脚本）
web/                 React 前端（登录/任务/详情 SSE/管理后台）
deploy/              compose、Dockerfile、e2e/load 脚本
```
