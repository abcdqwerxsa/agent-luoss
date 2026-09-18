"""
插件管理与 RBAC 权限配置 REST 接口
Plugin Management and RBAC Configuration Endpoints
"""

from typing import Dict, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.dependencies import get_plugin_registry
from app.plugins.registry import PluginRegistry

router = APIRouter(prefix="/plugins", tags=["Plugins & RBAC"])


class UpdateRolePermissionRequest(BaseModel):
    role: str = Field(..., description="角色名称 (如 admin, developer, reviewer, viewer)")
    allowed_plugins: List[str] = Field(..., description="授权使用的插件名称列表")


@router.get("")
async def list_plugins(registry: PluginRegistry = Depends(get_plugin_registry)):
    """获取所有已加载的插件元数据与导出的工具契约列表"""
    return {"plugins": registry.list_plugins()}


@router.get("/rbac")
async def get_rbac_policies(registry: PluginRegistry = Depends(get_plugin_registry)):
    """获取当前的 RBAC 角色与插件白名单对应关系"""
    return {"policies": registry.get_role_permissions()}


@router.post("/rbac")
async def update_rbac_policy(
    req: UpdateRolePermissionRequest,
    registry: PluginRegistry = Depends(get_plugin_registry),
):
    """动态更新或添加角色的插件白名单"""
    registry.update_role_permissions(req.role, req.allowed_plugins)
    return {
        "status": "success",
        "message": f"角色 '{req.role}' 权限已更新",
        "role": req.role,
        "allowed_plugins": req.allowed_plugins,
    }


@router.get("/roles/{role}/tools")
async def list_tools_for_role(
    role: str,
    registry: PluginRegistry = Depends(get_plugin_registry),
):
    """查询指定角色在 RBAC 过滤后能够调用的所有工具清单"""
    tools = registry.get_tools_for_role(role)
    return {
        "role": role,
        "tools": [tool.model_dump() for tool in tools],
        "total_count": len(tools),
    }
