"""
工作区数据模型定义
Workspace Data Models and Quota Schemas
"""

from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class WorkspaceStatus(str, Enum):
    ACTIVE = "active"
    FROZEN = "frozen"
    QUOTA_EXCEEDED = "quota_exceeded"
    CLEANED = "cleaned"


class QuotaUsage(BaseModel):
    """工作区配额使用指标"""
    current_bytes: int = Field(..., description="当前已使用存储空间 (字节)")
    current_mb: float = Field(..., description="当前已使用存储空间 (MB)")
    hard_quota_bytes: int = Field(..., description="硬配额上限 (字节)")
    hard_quota_mb: float = Field(..., description="硬配额上限 (MB)")
    soft_quota_bytes: int = Field(..., description="软配额上限 (字节)")
    soft_quota_mb: float = Field(..., description="软配额上限 (MB)")
    usage_ratio: float = Field(..., description="配额占用比率 (0.0 ~ 1.0+)")
    is_soft_exceeded: bool = Field(..., description="是否触发软配额预警")
    is_hard_exceeded: bool = Field(..., description="是否触发硬配额熔断")


class CreateWorkspaceRequest(BaseModel):
    """创建工作区请求体"""
    tenant_id: str = Field(..., min_length=1, max_length=64, description="租户标识")
    agent_id: str = Field(..., min_length=1, max_length=64, description="Agent 实例标识")
    hard_quota_bytes: Optional[int] = Field(None, description="自定义硬配额上限 (字节)")
    soft_quota_bytes: Optional[int] = Field(None, description="自定义软配额上限 (字节)")


class WorkspaceInfo(BaseModel):
    """工作区详细元数据"""
    tenant_id: str
    agent_id: str
    workspace_path: str
    status: WorkspaceStatus
    hard_quota_bytes: int
    soft_quota_bytes: int
    created_at: datetime
    updated_at: datetime
