"""
插件注册中枢与 RBAC 权限拦截中心
Plugin Registry and RBAC Permission Interceptor
"""

from typing import Any, Dict, List, Optional
from app.config import settings
from app.core.exceptions import PluginExecutionError, RBACPermissionError
from app.core.logger import logger
from app.plugins.base import BasePlugin, PluginExecutionContext, ToolDefinition
from app.plugins.builtin import CodeViewerPlugin, GitCommitterPlugin, RestrictedBashPlugin


class PluginRegistry:
    """插件注册表与鉴权调度器"""

    def __init__(self):
        self._plugins: Dict[str, BasePlugin] = {}
        self._tool_to_plugin: Dict[str, str] = {}
        self._role_permissions: Dict[str, List[str]] = dict(settings.DEFAULT_ROLE_PERMISSIONS)
        self._register_builtins()

    def _register_builtins(self):
        """自动注册平台内置的核心基础插件"""
        builtins = [
            RestrictedBashPlugin(),
            CodeViewerPlugin(),
            GitCommitterPlugin(),
        ]
        for plugin in builtins:
            self.register(plugin)

    def register(self, plugin: BasePlugin) -> None:
        """注册一个新插件"""
        self._plugins[plugin.name] = plugin
        for tool in plugin.get_tools():
            self._tool_to_plugin[tool.name] = plugin.name
        logger.info(f"成功载入插件: {plugin.name}, 包含工具: {[t.name for t in plugin.get_tools()]}")

    def get_plugin(self, name: str) -> Optional[BasePlugin]:
        return self._plugins.get(name)

    def get_plugin_for_tool(self, tool_name: str) -> Optional[BasePlugin]:
        plugin_name = self._tool_to_plugin.get(tool_name)
        if not plugin_name:
            return None
        return self._plugins.get(plugin_name)

    def list_plugins(self) -> List[Dict[str, Any]]:
        """获取所有已加载的插件及其工具清单"""
        result = []
        for name, plugin in self._plugins.items():
            result.append({
                "name": name,
                "description": plugin.description,
                "tools": [tool.model_dump() for tool in plugin.get_tools()],
            })
        return result

    def get_role_permissions(self) -> Dict[str, List[str]]:
        return dict(self._role_permissions)

    def update_role_permissions(self, role: str, allowed_plugins: List[str]) -> None:
        """动态配置角色的插件白名单"""
        self._role_permissions[role] = allowed_plugins
        logger.info(f"更新角色权限规则: 角色={role}, 授权插件={allowed_plugins}")

    def is_plugin_allowed(self, role: str, plugin_name: str) -> bool:
        """检查特定角色是否被允许调用指定插件"""
        allowed = self._role_permissions.get(role, [])
        return plugin_name in allowed

    def get_tools_for_role(self, role: str) -> List[ToolDefinition]:
        """按角色白名单过滤可用的工具清单"""
        allowed_plugins = set(self._role_permissions.get(role, []))
        tools: List[ToolDefinition] = []
        for p_name in allowed_plugins:
            if p_name in self._plugins:
                tools.extend(self._plugins[p_name].get_tools())
        return tools

    async def dispatch(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        context: PluginExecutionContext,
    ) -> Dict[str, Any]:
        """
        统一分发执行工具调用，强制进行 RBAC 拦截与日志记录
        """
        plugin = self.get_plugin_for_tool(tool_name)
        if not plugin:
            raise PluginExecutionError("system", f"未找到名为 '{tool_name}' 的对应工具插件")

        # RBAC 鉴权拦截
        if not self.is_plugin_allowed(context.role, plugin.name):
            logger.warning(
                f"RBAC 鉴权拦截: 租户={context.tenant_id}, Agent={context.agent_id}, "
                f"角色={context.role} 企图越权调用插件={plugin.name}, 工具={tool_name}"
            )
            raise RBACPermissionError(role=context.role, plugin_name=plugin.name)

        # 执行插件逻辑
        return await plugin.execute(tool_name, arguments, context)


plugin_registry = PluginRegistry()
