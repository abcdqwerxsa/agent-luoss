"""
Agent-Luoss 平台主应用入口
FastAPI Application Entrypoint
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.router import api_v1_router
from app.config import settings
from app.core.exceptions import (
    BasePlatformException,
    PathTraversalError,
    QuotaExceededError,
    RBACPermissionError,
    WorkspaceNotFoundError,
)
from app.core.logger import logger
from app.workspace.manager import workspace_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理器 (启动与关闭清理)"""
    logger.info(f"=== {settings.APP_NAME} v{settings.VERSION} 正在启动 ===")
    logger.info(f"工作区根路径: {settings.WORKSPACES_ROOT}")
    logger.info("初始化内置插件与安全防护沙箱...")
    yield
    logger.info("=== 平台正在关闭，正在安全回收所有执行上下文 ===")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    description="企业级内网 Coding-Agent 管理平台与安全调度中枢",
    lifespan=lifespan,
)

# 离线环境与内网跨域支持
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 挂载 API 路由
app.include_router(api_v1_router)


@app.get("/health", tags=["System"])
async def health_check():
    """容器与编排健康检查探针"""
    return {
        "status": "healthy",
        "app": settings.APP_NAME,
        "version": settings.VERSION,
        "workspaces_root": str(workspace_manager.base_dir),
    }


# ================= 全局业务异常处理器 =================

@app.exception_handler(PathTraversalError)
async def path_traversal_handler(request: Request, exc: PathTraversalError):
    logger.critical(f"路径穿越安全拦截: {exc.message}")
    return JSONResponse(
        status_code=status.HTTP_403_FORBIDDEN,
        content={"error_type": "PathTraversalForbidden", "message": exc.message, "details": exc.details},
    )


@app.exception_handler(QuotaExceededError)
async def quota_exceeded_handler(request: Request, exc: QuotaExceededError):
    logger.error(f"存储配额熔断告警: {exc.message}")
    return JSONResponse(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        content={"error_type": "QuotaExceeded", "message": exc.message, "details": exc.details},
    )


@app.exception_handler(RBACPermissionError)
async def rbac_permission_handler(request: Request, exc: RBACPermissionError):
    logger.warning(f"RBAC 权限拒绝: {exc.message}")
    return JSONResponse(
        status_code=status.HTTP_403_FORBIDDEN,
        content={"error_type": "PermissionDenied", "message": exc.message, "details": exc.details},
    )


@app.exception_handler(WorkspaceNotFoundError)
async def workspace_not_found_handler(request: Request, exc: WorkspaceNotFoundError):
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content={"error_type": "WorkspaceNotFound", "message": exc.message, "details": exc.details},
    )


@app.exception_handler(BasePlatformException)
async def generic_platform_handler(request: Request, exc: BasePlatformException):
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"error_type": "PlatformError", "message": exc.message, "details": exc.details},
    )
