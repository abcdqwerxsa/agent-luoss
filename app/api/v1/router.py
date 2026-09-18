"""
API v1 聚合路由
API v1 Router Aggregation
"""

from fastapi import APIRouter
from app.api.v1.agents import router as agents_router
from app.api.v1.plugins import router as plugins_router
from app.api.v1.workspaces import router as workspaces_router

api_v1_router = APIRouter(prefix="/api/v1")

api_v1_router.include_router(workspaces_router)
api_v1_router.include_router(agents_router)
api_v1_router.include_router(plugins_router)
