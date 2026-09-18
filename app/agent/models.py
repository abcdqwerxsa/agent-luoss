"""
Agent 数据模型与 JSON-RPC 协议结构
Agent Models and JSON-RPC Protocol Payloads
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class AgentStatus(str, Enum):
    INITIALIZING = "initializing"
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    QUOTA_EXCEEDED = "quota_exceeded"
    STOPPED = "stopped"


class EventType(str, Enum):
    STATUS_CHANGE = "status_change"
    THOUGHT = "thought"
    TOOL_CALL_START = "tool_call_start"
    TOOL_CALL_RESULT = "tool_call_result"
    STDOUT = "stdout"
    STDERR = "stderr"
    QUOTA_ALERT = "quota_alert"
    ERROR = "error"
    DONE = "done"


class AgentEvent(BaseModel):
    """流式推送给前端/客户端的原子事件"""
    agent_id: str
    tenant_id: str
    event_type: EventType
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    payload: Dict[str, Any] = Field(default_factory=dict)


class JsonRpcRequest(BaseModel):
    """JSON-RPC 2.0 请求格式"""
    jsonrpc: str = "2.0"
    id: str | int
    method: str
    params: Dict[str, Any] = Field(default_factory=dict)


class JsonRpcResponse(BaseModel):
    """JSON-RPC 2.0 响应格式"""
    jsonrpc: str = "2.0"
    id: str | int
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None


class PlannedStep(BaseModel):
    """预设或 Agent 规划的单步执行计划"""
    tool_name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)
    thought: Optional[str] = None


class CreateTaskRequest(BaseModel):
    """创建并启动 Agent 任务请求"""
    tenant_id: str = Field(..., description="租户标识")
    agent_id: str = Field(..., description="Agent 实例标识")
    role: str = Field(default="developer", description="分配给 Agent 的 RBAC 角色")
    prompt: str = Field(..., description="用户提示词或工程目标")
    planned_steps: Optional[List[PlannedStep]] = Field(
        default=None,
        description="可选预设步骤序列（用于批处理或确定性测试场景）",
    )
    hard_quota_bytes: Optional[int] = Field(None, description="自定义存储硬配额")
    soft_quota_bytes: Optional[int] = Field(None, description="自定义存储软配额")


class TaskStatusResponse(BaseModel):
    """任务查询状态返回"""
    tenant_id: str
    agent_id: str
    role: str
    status: AgentStatus
    current_step: int
    total_steps: int
    created_at: datetime
    updated_at: datetime
    error_message: Optional[str] = None
