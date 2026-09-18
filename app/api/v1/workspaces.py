"""
工作区与配额管理 REST 接口
Workspace and Quota REST Endpoints
"""

from fastapi import APIRouter, Depends, HTTPException, status
from app.api.dependencies import get_workspace_manager
from app.core.exceptions import BasePlatformException, WorkspaceNotFoundError
from app.workspace.manager import WorkspaceManager
from app.workspace.models import CreateWorkspaceRequest, QuotaUsage, WorkspaceInfo

router = APIRouter(prefix="/workspaces", tags=["Workspaces"])


@router.post("", response_model=WorkspaceInfo, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    req: CreateWorkspaceRequest,
    mgr: WorkspaceManager = Depends(get_workspace_manager),
):
    """创建或初始化特定租户与 Agent 的隔离工作区"""
    try:
        return mgr.create_workspace(
            tenant_id=req.tenant_id,
            agent_id=req.agent_id,
            hard_quota_bytes=req.hard_quota_bytes,
            soft_quota_bytes=req.soft_quota_bytes,
        )
    except BasePlatformException as e:
        raise HTTPException(status_code=400, detail=e.message)


@router.get("/{tenant_id}/{agent_id}", response_model=WorkspaceInfo)
async def get_workspace(
    tenant_id: str,
    agent_id: str,
    mgr: WorkspaceManager = Depends(get_workspace_manager),
):
    """查询指定工作区的元数据信息"""
    try:
        return mgr.get_workspace(tenant_id, agent_id)
    except WorkspaceNotFoundError as e:
        raise HTTPException(status_code=404, detail=e.message)
    except BasePlatformException as e:
        raise HTTPException(status_code=400, detail=e.message)


@router.get("/{tenant_id}/{agent_id}/quota", response_model=QuotaUsage)
async def get_workspace_quota(
    tenant_id: str,
    agent_id: str,
    mgr: WorkspaceManager = Depends(get_workspace_manager),
):
    """查询指定工作区的实时物理存储使用量与配额熔断状态"""
    try:
        return mgr.get_quota(tenant_id, agent_id)
    except WorkspaceNotFoundError as e:
        raise HTTPException(status_code=404, detail=e.message)
    except BasePlatformException as e:
        raise HTTPException(status_code=400, detail=e.message)


@router.delete("/{tenant_id}/{agent_id}", status_code=status.HTTP_200_OK)
async def clean_workspace(
    tenant_id: str,
    agent_id: str,
    mgr: WorkspaceManager = Depends(get_workspace_manager),
):
    """物理销毁并清空工作区文件"""
    try:
        success = mgr.clean_workspace(tenant_id, agent_id)
        if not success:
            raise HTTPException(status_code=404, detail="工作区不存在或已被清理")
        return {"status": "success", "message": "工作区已成功清空销毁"}
    except BasePlatformException as e:
        raise HTTPException(status_code=400, detail=e.message)
