"""
FastAPI 依赖注入组件
Dependency Injection Providers
"""

from app.agent.runner import agent_runner
from app.agent.session import session_manager
from app.plugins.registry import plugin_registry
from app.workspace.manager import workspace_manager


def get_workspace_manager():
    return workspace_manager


def get_session_manager():
    return session_manager


def get_agent_runner():
    return agent_runner


def get_plugin_registry():
    return plugin_registry
