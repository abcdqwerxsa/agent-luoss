# ===================================================
# Dockerfile: Agent-Luoss 平台离线可编排容器镜像
# 遵循 Apache-2.0 开源规范，纯离线就绪，无外部网络依赖
# ===================================================

FROM python:3.11-slim

LABEL maintainer="Agent-Luoss Team"
LABEL description="Enterprise-Grade Offline Coding-Agent Management Platform"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    WORKSPACES_ROOT=/data/workspaces

# 安装基础命令工具 (Git 用于版本管理，curl 用于健康检查，procps 用于进程管理)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# 配置工作目录与持久化工作区挂载点
WORKDIR /app
RUN mkdir -p /data/workspaces /app/data/workspaces

# 安装 uv 快速包管理器
RUN pip install --no-cache-dir uv

# 拷贝依赖配置并进行离线安装
COPY pyproject.toml README.md /app/
RUN uv pip install --system -e .

# 拷贝项目源代码
COPY app/ /app/app/

# 创建专用运行用户 (安全最小特权)
RUN useradd -u 1000 -m -s /bin/bash agentuser && \
    chown -R agentuser:agentuser /app /data/workspaces

USER agentuser

EXPOSE 8000

# 健康检查探针
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# 启动 FastAPI 服务
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
