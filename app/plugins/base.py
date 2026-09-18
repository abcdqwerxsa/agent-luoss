"""
插件抽象基类与标准工具契约定义
Base Plugin Interface and Tool Contract Specifications
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from pydantic import BaseModel, Field


class ToolParameter(BaseModel):
    """工具参数描述"""
    type: str
    description: str
    required: bool = True
    default: Optional[Any] = None
    enum: Optional[List[str]] = None


class ToolDefinition(BaseModel):
    """符合 JSON-RPC / MCP / OpenAI 标准的工具定义规范"""
    name: str = Field(..., description="工具唯一标识符")
    description: str = Field(..., description="工具功能用途说明")
    parameters: Dict[str, Any] = Field(
        default_factory=dict,
        description="JSON Schema 格式的参数规格"
    )


@dataclass
class PluginExecutionContext:
    """插件执行时注入的上下文环境"""
    tenant_id: str
    agent_id: str
    workspace_root: Path
    role: str = "developer"
    hard_quota_bytes: int = 500 * 1024 * 1024
    soft_quota_bytes: int = 400 * 1024 * 1024
    extra_env: Optional[Dict[str, str]] = None


class BasePlugin(ABC):
    """插件核心抽象基类"""

    @property
    @abstractmethod
    def name(self) -> str:
        """插件名称"""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """插件描述"""
        pass

    @abstractmethod
    def get_tools(self) -> List[ToolDefinition]:
        """获取该插件导出的所有工具元数据"""
        pass

    @abstractmethod
    async def execute(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        context: PluginExecutionContext,
    ) -> Dict[str, Any]:
        """
        执行工具调用，返回执行结果字典

        :param tool_name: 调用的具体工具名称
        :param arguments: 工具入参
        :param context: 注入的工作区上下文（包含路径、租户与 Agent 信息）
        :return: 结果字典 (如包含 status, output, error 等)
        """
        pass
