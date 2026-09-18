"""
工作区生命周期与安全隔离管理器
Workspace Lifecycle and Security Isolation Manager
"""

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.config import settings
from app.core.exceptions import (
    PathTraversalError,
    QuotaExceededError,
    SecurityException,
    WorkspaceNotFoundError,
)
from app.core.logger import logger
from app.core.security import sanitize_path
from app.workspace.models import QuotaUsage, WorkspaceInfo, WorkspaceStatus
from app.workspace.quota import assert_can_write, inspect_quota


SAFE_ID_REGEX = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


class WorkspaceManager:
    """工作区全生命周期管理与安全隔离服务"""

    def __init__(self, base_dir: Optional[str] = None):
        self.base_dir = Path(base_dir or settings.WORKSPACES_ROOT).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"WorkspaceManager 初始化就绪，根工作目录: {self.base_dir}")

    def _validate_identifier(self, ident: str, name: str) -> None:
        """严格校验 tenant_id 与 agent_id，防止字符逃逸攻击"""
        if not SAFE_ID_REGEX.match(ident):
            raise SecurityException(
                f"非法的 {name} 标识符: '{ident}'。必须仅包含 1-64 位字母、数字、下划线或连字符。"
            )

    def get_workspace_dir(self, tenant_id: str, agent_id: str) -> Path:
        """计算物理工作区绝对路径"""
        self._validate_identifier(tenant_id, "tenant_id")
        self._validate_identifier(agent_id, "agent_id")
        return self.base_dir / tenant_id / agent_id

    def _get_meta_path(self, workspace_dir: Path) -> Path:
        return workspace_dir / ".workspace_meta.json"

    def create_workspace(
        self,
        tenant_id: str,
        agent_id: str,
        hard_quota_bytes: Optional[int] = None,
        soft_quota_bytes: Optional[int] = None,
    ) -> WorkspaceInfo:
        """创建独立隔离工作区目录并持久化配置元数据"""
        ws_dir = self.get_workspace_dir(tenant_id, agent_id)
        ws_dir.mkdir(parents=True, exist_ok=True)

        hard_quota = hard_quota_bytes or settings.DEFAULT_HARD_QUOTA_BYTES
        soft_quota = soft_quota_bytes or int(hard_quota * 0.8)

        now = datetime.now(timezone.utc)
        meta = WorkspaceInfo(
            tenant_id=tenant_id,
            agent_id=agent_id,
            workspace_path=str(ws_dir),
            status=WorkspaceStatus.ACTIVE,
            hard_quota_bytes=hard_quota,
            soft_quota_bytes=soft_quota,
            created_at=now,
            updated_at=now,
        )

        # 保存元数据
        meta_file = self._get_meta_path(ws_dir)
        meta_file.write_text(meta.model_dump_json(indent=2), encoding="utf-8")
        logger.info(f"成功创建并初始化工作区: tenant={tenant_id}, agent={agent_id}, 路径={ws_dir}")
        return meta

    def get_workspace(self, tenant_id: str, agent_id: str) -> WorkspaceInfo:
        """获取工作区信息"""
        ws_dir = self.get_workspace_dir(tenant_id, agent_id)
        if not ws_dir.exists():
            raise WorkspaceNotFoundError(tenant_id, agent_id)

        meta_file = self._get_meta_path(ws_dir)
        if meta_file.exists():
            try:
                data = json.loads(meta_file.read_text(encoding="utf-8"))
                return WorkspaceInfo(**data)
            except Exception as e:
                logger.warning(f"读取工作区元数据失败，重新生成: {e}")

        # 若无元数据文件但目录存在，以默认设置补充
        now = datetime.now(timezone.utc)
        return WorkspaceInfo(
            tenant_id=tenant_id,
            agent_id=agent_id,
            workspace_path=str(ws_dir),
            status=WorkspaceStatus.ACTIVE,
            hard_quota_bytes=settings.DEFAULT_HARD_QUOTA_BYTES,
            soft_quota_bytes=settings.DEFAULT_SOFT_QUOTA_BYTES,
            created_at=now,
            updated_at=now,
        )

    def get_quota(self, tenant_id: str, agent_id: str) -> QuotaUsage:
        """获取工作区配额使用指标"""
        info = self.get_workspace(tenant_id, agent_id)
        ws_dir = Path(info.workspace_path)
        return inspect_quota(ws_dir, info.hard_quota_bytes, info.soft_quota_bytes)

    def safe_resolve(self, tenant_id: str, agent_id: str, relative_or_abs_path: str) -> Path:
        """
        在特定工作区内安全解析路径，严格防止跨目录越界
        """
        info = self.get_workspace(tenant_id, agent_id)
        ws_dir = Path(info.workspace_path)
        return sanitize_path(ws_dir, relative_or_abs_path)

    def verify_write_quota(self, tenant_id: str, agent_id: str, incoming_bytes: int) -> None:
        """
        写入或命令执行前校验容量熔断
        """
        info = self.get_workspace(tenant_id, agent_id)
        ws_dir = Path(info.workspace_path)
        assert_can_write(ws_dir, incoming_bytes, info.hard_quota_bytes, info.soft_quota_bytes)

    def freeze_workspace(self, tenant_id: str, agent_id: str, reason: str = "quota_exceeded") -> None:
        """熔断并冻结工作区"""
        ws = self.get_workspace(tenant_id, agent_id)
        ws.status = WorkspaceStatus.QUOTA_EXCEEDED if reason == "quota_exceeded" else WorkspaceStatus.FROZEN
        ws.updated_at = datetime.now(timezone.utc)
        meta_file = self._get_meta_path(Path(ws.workspace_path))
        meta_file.write_text(ws.model_dump_json(indent=2), encoding="utf-8")
        logger.warning(f"工作区状态更新为冻结: {tenant_id}/{agent_id}, 原因={reason}")

    def clean_workspace(self, tenant_id: str, agent_id: str) -> bool:
        """安全物理销毁工作区所有文件"""
        ws_dir = self.get_workspace_dir(tenant_id, agent_id)
        if not ws_dir.exists():
            return False

        shutil.rmtree(ws_dir, ignore_errors=True)
        logger.info(f"已清理销毁工作区: tenant={tenant_id}, agent={agent_id}")
        return True


workspace_manager = WorkspaceManager()
