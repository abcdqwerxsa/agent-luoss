# Agent-Luoss: 企业级内网 Coding-Agent 管理平台

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Python](https://img.shields.io/badge/Python-3.11%2B-brightgreen.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110%2B-teal.svg)](https://fastapi.tiangolo.com/)
[![Docker](https://img.shields.io/badge/Docker-Offline%20Ready-blue.svg)](https://www.docker.com/)

开箱即用的**企业级内网 Coding-Agent 管理平台与运行时中枢**。专为金融、涉密及隔离网络等企业纯内网环境设计，具备**目录级工作区强隔离**、**存储配额软硬熔断**、**pi-agent 规范 JSON-RPC 调度**、**细粒度 RBAC 插件管控**与**纯离线 Docker 一键交付**能力。

---

## 核心架构与设计规范

```
                        +---------------------------------------+
                        |  Web 前端 / CLI / 调度上游系统 (Client)  |
                        +---------------------------------------+
                                  |                 |
                    REST / WS / SSE (HTTP/WS)   JSON-RPC 2.0
                                  |                 |
+=================================v=================v=================================+
|                              Agent-Luoss 控制面中枢                                   |
|                                                                                     |
|   +-----------------------+   +-----------------------+   +---------------------+   |
|   |   FastAPI REST API    |   |  pi-agent 运行时适配   |   |   RBAC 鉴权拦截中心   |   |
|   | (/api/v1/workspaces,  |   | (JSON-RPC 2.0 / MCP / |   | (角色白名单/动态授权)|   |
|   |  /agents, /plugins)   |   |  SSE & WS 实时流推送)  |   |                     |   |
|   +-----------------------+   +-----------------------+   +---------------------+   |
|                                           |                                         |
|                                           v                                         |
|   +-----------------------------------------------------------------------------+   |
|   |                         Agent-Loop 核心调度引擎                              |   |
|   |               [Init] ──> [Step: 规划/工具调用] ──> [Stream] ──> [Finish]     |   |
|   +-----------------------------------------------------------------------------+   |
|            |                                              |                         |
|            v                                              v                         |
|   +-----------------------+                      +-------------------------------+  |
|   |   插件与工具执行沙箱    |                      |      工作区与配额安全引擎     |  |
|   |  - restricted_bash    |                      |  - 防路径穿越 (Anti-Traversal)|  |
|   |  - code_viewer        |                      |  - 实时物理容量扫描           |  |
|   |  - git_committer      |                      |  - 硬配额毫秒级熔断控制器     |  |
|   +-----------------------+                      +-------------------------------+  |
|            |                                              |                         |
+============|==============================================|=========================+
             v                                              v
+-------------------------------------------------------------------------------------+
|                      隔离工作区目录: /data/workspaces/{tenant_id}/{agent_id}/        |
+-------------------------------------------------------------------------------------+
```

### 1. 工作区隔离与配额引擎 (Workspace & Quota Engine)
- **租户/Agent 独立目录隔离**：标准分配目录 `/data/workspaces/{tenant_id}/{agent_id}/`。
- **严格防路径穿越 (Anti-Path Traversal)**：核心安全函数 `sanitize_path` 对所有相对与绝对路径进行物理规范化（`os.path.realpath`），确保解析结果的公共根路径严格锁定在工作区内，彻底杜绝 `../` 或符号链接越界逃逸。
- **存储配额监控与熔断控制器 (Circuit Breaker)**：
  - 支持软配额（Soft Quota，默认 80% 触发告警事件）与硬配额（Hard Quota，默认 500MB，可按需指定）。
  - 在文件写入、代码生成及命令执行前后进行存储容量断言；一旦超限立即触发熔断保护，更新 Agent 状态为 `QUOTA_EXCEEDED`，冻结工作区并中断 Loop。

### 2. pi-agent 运行时适配层 (pi-agent Runtime Adapter)
- **JSON-RPC 2.0 规范调度**：原生兼容标准 JSON-RPC 2.0 协议协议包（`id`, `jsonrpc`, `method`, `params`），无缝对接外部独立 pi-agent 实例或使用内置调度驱动。
- **全生命周期管控**：
  - **Init**：配额健康检查、挂载隔离目录、导出按 RBAC 角色过滤的工具 Schema。
  - **Step**：监听与转发 Tool Calls（Shell 命令执行、源码切片读写、Git 仓库操作）。
  - **Stream**：通过内置事件总线（Event Bus）将 Agent 的思考演进（Thought）、工具调用参数、标准输出（Stdout）与错误（Stderr）通过 **SSE (`/stream`)** 与 **WebSocket (`/ws`)** 实时推送给前端。

### 3. 管理控制面与插件中枢 (Plugin & Permission Hub)
- **标准化插件模型**：遵循 Tool Calling / MCP 规范，自描述工具参数 JSON Schema。
- **RBAC 鉴权拦截**：管理员可按角色（如 `admin`, `developer`, `reviewer`, `viewer`）定义插件白名单，在工具调度入口进行拦截并记录审计日志。
- **内置核心开源插件**：
  - `restricted_bash`：受限 Shell 插件，绑定当前工作区根目录，内置高危命令防火墙（拦截 `rm -rf /`、Fork 炸弹、`mkfs`、提权逃逸等），支持超时保护与流式输出。
  - `code_viewer`：安全代码查看与编辑器，提供分行读取、安全覆盖写入（前置配额熔断检查）、目录遍历与文本检索。
  - `git_committer`：安全 Git 操作插件，提供受限环境下的 `git init`、`git status`、`git diff`、`git commit` 与提交日志审计。

---

## 项目目录结构

```
agent-luoss/
├── Dockerfile                         # 生产级多阶离线镜像构建配置
├── docker-compose.yml                 # 纯内网一键编排配置 (含卷挂载与健康检查)
├── pyproject.toml                     # 项目元数据与依赖配置
├── README.md                          # 架构与开发运维手册
├── .dockerignore                      # Docker 忽略文件
├── app/
│   ├── __init__.py                    # 核心包声明
│   ├── main.py                        # FastAPI 主应用入口与全局异常处理器
│   ├── config.py                      # 全局配置中心 (Pydantic Settings)
│   ├── core/                          # 核心底层基础设施
│   │   ├── exceptions.py              # 统一业务与安全异常体系
│   │   ├── logger.py                  # 结构化彩色日志
│   │   └── security.py                # 防路径穿越校验与安全工具
│   ├── workspace/                     # 工作区隔离与配额引擎
│   │   ├── manager.py                 # 工作区生命周期管理器
│   │   ├── quota.py                   # 物理容量扫描与配额熔断器
│   │   └── models.py                  # 工作区及配额数据模型
│   ├── plugins/                       # 插件中枢与 RBAC
│   │   ├── base.py                    # 插件抽象基类与 Tool Schema 契约
│   │   ├── registry.py                # 插件注册中心与 RBAC 拦截器
│   │   └── builtin/                   # 内置开源插件实现
│   │       ├── restricted_bash.py     # 受限 Shell 执行插件
│   │       ├── code_viewer.py         # 源码读写与检索插件
│   │       └── git_committer.py       # Git 版本控制插件
│   ├── agent/                         # pi-agent 运行时调度与适配
│   │   ├── models.py                  # Agent 任务状态机与 JSON-RPC 模型
│   │   ├── session.py                 # 会话池管理与 SSE/WS 广播总线
│   │   ├── pi_adapter.py              # pi-agent 协议转换与工具调度适配器
│   │   └── runner.py                  # Agent-Loop 核心生命周期循环
│   └── api/                           # 控制面接口层
│       ├── dependencies.py            # FastAPI 依赖注入
│       └── v1/
│           ├── router.py              # v1 路由聚合
│           ├── workspaces.py          # 工作区与配额 RESTful 接口
│           ├── agents.py              # Agent 任务创建/终止/SSE流/WebSocket
│           └── plugins.py             # 插件列表与 RBAC 规则管理
├── data/
│   └── workspaces/                    # 工作区持久化挂载目录
└── tests/                             # 自动化测试套件
    ├── test_workspace_quota.py        # 路径隔离与配额熔断测试
    ├── test_plugins_rbac.py           # 插件功能与 RBAC 鉴权测试
    ├── test_agent_runner.py           # Agent Loop 与流式事件测试
    └── test_api.py                    # RESTful / SSE / WebSocket 接口测试
```

---

## 快速上手与运行

### 方式一：本地极速启动 (推荐使用 `uv`)

```bash
# 1. 确保安装 uv
uv --version

# 2. 安装项目全部依赖与测试套件
uv pip install -e ".[test]"

# 3. 运行完整自动化测试套件 (16 项单元与集成测试)
uv run pytest tests/ -v

# 4. 启动平台 API 服务
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 方式二：Docker Compose 纯内网离线编排

```bash
# 1. 一键后台构建并启动容器集群
docker compose up -d

# 2. 查看容器状态与健康探针
docker compose ps

# 3. 查看实时日志
docker compose logs -f agent-platform
```

---

## 完整生命周期 API 调用示例 (cURL)

以下展示从创建工作区、查看配额、启动 Agent 任务到通过 SSE 实时监听思考过程的完整生命周期。

### 1. 服务健康检查
```bash
curl -s http://localhost:8000/health | jq .
```
**返回示例**：
```json
{
  "status": "healthy",
  "app": "Agent-Luoss",
  "version": "0.1.0",
  "workspaces_root": "/data/workspaces"
}
```

---

### 2. 创建独立工作区并分配配额
```bash
curl -s -X POST http://localhost:8000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "finance_dept",
    "agent_id": "coder_agent_01",
    "hard_quota_bytes": 104857600,
    "soft_quota_bytes": 83886080
  }' | jq .
```
**返回示例**：
```json
{
  "tenant_id": "finance_dept",
  "agent_id": "coder_agent_01",
  "workspace_path": "/data/workspaces/finance_dept/coder_agent_01",
  "status": "active",
  "hard_quota_bytes": 104857600,
  "soft_quota_bytes": 83886080,
  "created_at": "2026-09-18T15:30:00Z",
  "updated_at": "2026-09-18T15:30:00Z"
}
```

---

### 3. 查看工作区实时存储用量与配额状态
```bash
curl -s http://localhost:8000/api/v1/workspaces/finance_dept/coder_agent_01/quota | jq .
```
**返回示例**：
```json
{
  "current_bytes": 4096,
  "current_mb": 0.004,
  "hard_quota_bytes": 104857600,
  "hard_quota_mb": 100.0,
  "soft_quota_bytes": 83886080,
  "soft_quota_mb": 80.0,
  "usage_ratio": 0.0001,
  "is_soft_exceeded": false,
  "is_hard_exceeded": false
}
```

---

### 4. 提交 Agent 任务
提交一个具有代码编写、环境执行、Git 初始化的多步骤任务：
```bash
curl -s -X POST http://localhost:8000/api/v1/agents/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "finance_dept",
    "agent_id": "coder_agent_01",
    "role": "developer",
    "prompt": "编写并初始化一个示例算法脚本，并提交至本地 Git 仓库",
    "planned_steps": [
      {
        "tool_name": "write_file",
        "arguments": {
          "path": "calculator.py",
          "content": "def add(a, b):\n    return a + b\n\nif __name__ == \"__main__\":\n    print(\"Calculation result:\", add(10, 20))\n"
        },
        "thought": "正在工作区编写计算器核心算法代码..."
      },
      {
        "tool_name": "execute_bash",
        "arguments": {
          "command": "python3 calculator.py"
        },
        "thought": "正在执行刚生成的计算器脚本以校验逻辑..."
      },
      {
        "tool_name": "git_init",
        "arguments": {},
        "thought": "初始化本地 Git 版本库..."
      },
      {
        "tool_name": "git_commit",
        "arguments": {
          "message": "feat: 初始算法模块与单元测试"
        },
        "thought": "将编写的代码提交至 Git..."
      }
    ]
  }' | jq .
```
**返回示例**：
```json
{
  "tenant_id": "finance_dept",
  "agent_id": "coder_agent_01",
  "role": "developer",
  "status": "initializing",
  "current_step": 0,
  "total_steps": 0,
  "created_at": "2026-09-18T15:30:10Z",
  "updated_at": "2026-09-18T15:30:10Z"
}
```

---

### 5. 实时 SSE 流式消费 Agent 思考与执行细节
```bash
curl -N http://localhost:8000/api/v1/agents/finance_dept/coder_agent_01/stream
```
**实时 SSE 流输出效果**：
```
event: status_change
data: {"agent_id":"coder_agent_01","tenant_id":"finance_dept","event_type":"status_change","timestamp":"...","payload":{"status":"initializing"}}

event: thought
data: {"agent_id":"coder_agent_01","tenant_id":"finance_dept","event_type":"thought","timestamp":"...","payload":{"thought":"正在工作区编写计算器核心算法代码..."}}

event: tool_call_start
data: {"agent_id":"coder_agent_01","tenant_id":"finance_dept","event_type":"tool_call_start","timestamp":"...","payload":{"step":1,"tool_name":"write_file","arguments":{"path":"calculator.py"}}}

event: tool_call_result
data: {"agent_id":"coder_agent_01","tenant_id":"finance_dept","event_type":"tool_call_result","timestamp":"...","payload":{"step":1,"tool_name":"write_file","result":{"status":"success","bytes_written":107}}}

event: thought
data: {"agent_id":"coder_agent_01","tenant_id":"finance_dept","event_type":"thought","timestamp":"...","payload":{"thought":"正在执行刚生成的计算器脚本以校验逻辑..."}}

event: stdout
data: {"agent_id":"coder_agent_01","tenant_id":"finance_dept","event_type":"stdout","timestamp":"...","payload":{"step":2,"text":"Calculation result: 30\n"}}

event: done
data: {"agent_id":"coder_agent_01","tenant_id":"finance_dept","event_type":"done","timestamp":"...","payload":{"status":"success","steps_executed":4}}
```

---

### 6. RBAC 权限管理接口
```bash
# 查询当前 RBAC 策略
curl -s http://localhost:8000/api/v1/plugins/rbac | jq .

# 动态为 reviewer 角色增加 restricted_bash 工具权限
curl -s -X POST http://localhost:8000/api/v1/plugins/rbac \
  -H "Content-Type: application/json" \
  -d '{
    "role": "reviewer",
    "allowed_plugins": ["code_viewer", "git_committer", "restricted_bash"]
  }' | jq .
```

---

## 许可证说明
本项目完全遵循 [Apache-2.0 许可证](LICENSE)，所有内置核心组件与第三方依赖均为宽松商用开源协议，适用于商业软件二次开发与企业私有化部署。
