"""
统一业务异常体系
Unified Exception Classes for Agent Management Platform
"""

from typing import Any, Optional


class BasePlatformException(Exception):
    """平台基础异常基类"""

    def __init__(self, message: str, details: Optional[Any] = None):
        super().__init__(message)
        self.message = message
        self.details = details


class SecurityException(BasePlatformException):
    """安全与权限违规异常（如路径穿越、非法访问）"""
    pass


class PathTraversalError(SecurityException):
    """路径穿越攻击拦截异常"""

    def __init__(self, attempted_path: str, workspace_root: str):
        message = f"检测到非法路径穿越操作: '{attempted_path}' 试图越界超出工作区 '{workspace_root}'"
        super().__init__(message, details={"attempted_path": attempted_path, "workspace_root": workspace_root})


class QuotaExceededError(BasePlatformException):
    """工作区存储配额超限熔断异常"""

    def __init__(self, current_bytes: int, max_bytes: int, path: str):
        current_mb = current_bytes / (1024 * 1024)
        max_mb = max_bytes / (1024 * 1024)
        message = (
            f"工作区存储配额熔断！当前容量已达 {current_mb:.2f} MB，"
            f"硬配额上限为 {max_mb:.2f} MB (路径: {path})"
        )
        super().__init__(
            message,
            details={
                "current_bytes": current_bytes,
                "max_bytes": max_bytes,
                "current_mb": current_mb,
                "max_mb": max_mb,
                "path": path,
            },
        )


class RBACPermissionError(SecurityException):
    """RBAC 角色权限拒绝异常"""

    def __init__(self, role: str, plugin_name: str):
        message = f"角色 '{role}' 未被授权使用插件 '{plugin_name}'"
        super().__init__(message, details={"role": role, "plugin_name": plugin_name})


class PluginExecutionError(BasePlatformException):
    """插件执行故障异常"""

    def __init__(self, plugin_name: str, error_msg: str):
        message = f"插件 '{plugin_name}' 执行失败: {error_msg}"
        super().__init__(message, details={"plugin_name": plugin_name, "error": error_msg})


class WorkspaceNotFoundError(BasePlatformException):
    """工作区不存在异常"""

    def __init__(self, tenant_id: str, agent_id: str):
        message = f"工作区不存在: tenant_id='{tenant_id}', agent_id='{agent_id}'"
        super().__init__(message, details={"tenant_id": tenant_id, "agent_id": agent_id})


class AgentSessionNotFoundError(BasePlatformException):
    """Agent 会话不存在异常"""

    def __init__(self, agent_id: str):
        message = f"未找到指定 Agent 运行实例: agent_id='{agent_id}'"
        super().__init__(message, details={"agent_id": agent_id})
