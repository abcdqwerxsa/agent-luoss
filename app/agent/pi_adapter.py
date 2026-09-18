"""
pi-agent JSON-RPC 协议适配器与客户端
pi-agent JSON-RPC Adapter and Protocol Driver
"""

import json
from typing import Any, Dict, List, Optional
import httpx

from app.agent.models import JsonRpcRequest, JsonRpcResponse
from app.config import settings
from app.core.exceptions import PluginExecutionError
from app.core.logger import logger
from app.plugins.base import PluginExecutionContext, ToolDefinition
from app.plugins.registry import plugin_registry


class PiAgentAdapter:
    """pi-agent 规范客户端与 JSON-RPC 适配层"""

    def __init__(self, rpc_url: Optional[str] = None):
        self.rpc_url = rpc_url or settings.PI_AGENT_RPC_URL
        logger.info(f"PiAgentAdapter 初始化完成, 外部 RPC URL: {self.rpc_url or '内置驱动模式 (Embedded)'}")

    def build_rpc_request(self, method: str, params: Dict[str, Any], req_id: str | int = 1) -> JsonRpcRequest:
        """组装符合 JSON-RPC 2.0 规范的请求对象"""
        return JsonRpcRequest(
            jsonrpc="2.0",
            id=req_id,
            method=method,
            params=params,
        )

    def parse_rpc_response(self, raw_data: Dict[str, Any]) -> JsonRpcResponse:
        """解析并校验 JSON-RPC 2.0 响应"""
        return JsonRpcResponse.model_validate(raw_data)

    async def call_remote_rpc(self, request: JsonRpcRequest) -> JsonRpcResponse:
        """向外部独立的 pi-agent 运行时服务发送异步 JSON-RPC 请求"""
        if not self.rpc_url:
            raise RuntimeError("未配置 PI_AGENT_RPC_URL，无法发起远程 RPC")

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(self.rpc_url, json=request.model_dump())
            resp.raise_for_status()
            return self.parse_rpc_response(resp.json())

    def export_tools_schema_for_pi(self, role: str) -> List[Dict[str, Any]]:
        """
        导出适配 pi-agent / MCP 规范的工具 Schema 清单（按 RBAC 角色过滤）
        """
        tools = plugin_registry.get_tools_for_role(role)
        return [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in tools
        ]

    async def execute_tool_call(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        context: PluginExecutionContext,
    ) -> Dict[str, Any]:
        """
        拦截并执行 pi-agent 发起的工具调用，经由 RBAC 检查后交付本地沙箱插件
        """
        logger.info(
            f"[{context.tenant_id}/{context.agent_id}] 收到 pi-agent 工具执行调用: "
            f"tool={tool_name}, args={json.dumps(arguments, ensure_ascii=False)}"
        )
        return await plugin_registry.dispatch(tool_name, arguments, context)


pi_adapter = PiAgentAdapter()
