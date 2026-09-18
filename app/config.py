"""
平台全局配置中心
Global Configuration Management
"""

import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # 基础服务信息
    APP_NAME: str = "Agent-Luoss"
    VERSION: str = "0.1.0"
    DEBUG: bool = False
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # 工作区存储配置
    # 容器内默认为 /data/workspaces，本地开发环境回退到 ./data/workspaces
    WORKSPACES_ROOT: str = os.getenv(
        "WORKSPACES_ROOT",
        str(Path(__file__).parent.parent / "data" / "workspaces")
    )

    # 存储配额默认值 (字节)
    # 默认硬配额: 500MB，软配额: 400MB (80%)
    DEFAULT_HARD_QUOTA_BYTES: int = 500 * 1024 * 1024
    DEFAULT_SOFT_QUOTA_BYTES: int = 400 * 1024 * 1024

    # 命令执行配置
    BASH_TIMEOUT_SECONDS: int = 60
    MAX_OUTPUT_CHARS: int = 100_000

    # RBAC 默认角色与插件白名单映射
    DEFAULT_ROLE_PERMISSIONS: dict[str, list[str]] = {
        "admin": ["restricted_bash", "code_viewer", "git_committer"],
        "developer": ["restricted_bash", "code_viewer", "git_committer"],
        "reviewer": ["code_viewer", "git_committer"],
        "viewer": ["code_viewer"],
    }

    # pi-agent JSON-RPC 外部服务地址 (若配置则走独立 RPC，否则走内置驱动)
    PI_AGENT_RPC_URL: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()
