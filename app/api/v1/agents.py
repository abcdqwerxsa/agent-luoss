"""
Agent 任务调度、SSE 与 WebSocket 流式通信接口
Agent Task Execution, SSE and WebSocket Streaming Endpoints
"""

import asyncio
import json
from typing import AsyncGenerator
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from sse_starlette.sse import EventSourceResponse

from app.agent.models import CreateTaskRequest, TaskStatusResponse
from app.agent.runner import AgentRunner
from app.agent.session import AgentSessionManager
from app.api.dependencies import get_agent_runner, get_session_manager
from app.core.exceptions import AgentSessionNotFoundError, BasePlatformException
from app.core.logger import logger

router = APIRouter(prefix="/agents", tags=["Agents"])


@router.post("/tasks", response_model=TaskStatusResponse, status_code=status.HTTP_202_ACCEPTED)
async def submit_task(
    req: CreateTaskRequest,
    runner: AgentRunner = Depends(get_agent_runner),
):
    """提交并启动一个新的 Agent 任务"""
    try:
        session = runner.start_task(req)
        return TaskStatusResponse(
            tenant_id=session.tenant_id,
            agent_id=session.agent_id,
            role=session.role,
            status=session.status,
            current_step=session.current_step,
            total_steps=session.total_steps,
            created_at=session.created_at,
            updated_at=session.updated_at,
        )
    except BasePlatformException as e:
        raise HTTPException(status_code=400, detail=e.message)


@router.get("/{tenant_id}/{agent_id}/status", response_model=TaskStatusResponse)
async def get_task_status(
    tenant_id: str,
    agent_id: str,
    mgr: AgentSessionManager = Depends(get_session_manager),
):
    """查询指定 Agent 任务的当前状态"""
    try:
        session = mgr.get_session(tenant_id, agent_id)
        return TaskStatusResponse(
            tenant_id=session.tenant_id,
            agent_id=session.agent_id,
            role=session.role,
            status=session.status,
            current_step=session.current_step,
            total_steps=session.total_steps,
            created_at=session.created_at,
            updated_at=session.updated_at,
            error_message=session.error_message,
        )
    except AgentSessionNotFoundError as e:
        raise HTTPException(status_code=404, detail=e.message)


@router.post("/{tenant_id}/{agent_id}/stop")
async def stop_task(
    tenant_id: str,
    agent_id: str,
    runner: AgentRunner = Depends(get_agent_runner),
):
    """主动终止正在运行的 Agent 任务"""
    success = runner.stop_task(tenant_id, agent_id)
    if not success:
        raise HTTPException(status_code=404, detail="任务不存在或已终止")
    return {"status": "success", "message": "已向 Agent 发送停止信号"}


async def _sse_generator(session) -> AsyncGenerator[dict, None]:
    """SSE 事件生成器"""
    queue = session.subscribe()
    try:
        while True:
            # 监听队列事件
            event = await queue.get()
            yield {
                "event": event.event_type.value,
                "data": event.model_dump_json(),
            }
            # 如果到达终态且队列已空，则结束 SSE 响应流
            if event.event_type.value in ["done", "error"] and queue.empty():
                break
    except asyncio.CancelledError:
        pass
    finally:
        session.unsubscribe(queue)


@router.get("/{agent_id}/stream")
async def stream_agent_events(
    agent_id: str,
    mgr: AgentSessionManager = Depends(get_session_manager),
):
    """
    通过 SSE (Server-Sent Events) 实时流式接收 Agent 的思考过程、工具调用与标准输出
    """
    try:
        session = mgr.get_session_by_agent_id(agent_id)
    except AgentSessionNotFoundError as e:
        raise HTTPException(status_code=404, detail=e.message)

    return EventSourceResponse(_sse_generator(session))


@router.get("/{tenant_id}/{agent_id}/stream")
async def stream_agent_events_with_tenant(
    tenant_id: str,
    agent_id: str,
    mgr: AgentSessionManager = Depends(get_session_manager),
):
    """通过 tenant_id 与 agent_id 组合定位的 SSE 流"""
    try:
        session = mgr.get_session(tenant_id, agent_id)
    except AgentSessionNotFoundError as e:
        raise HTTPException(status_code=404, detail=e.message)

    return EventSourceResponse(_sse_generator(session))


@router.websocket("/{agent_id}/ws")
async def agent_websocket(
    websocket: WebSocket,
    agent_id: str,
    mgr: AgentSessionManager = Depends(get_session_manager),
):
    """
    WebSocket 双向交互通道：
    - 服务端向下推送 Agent 思考与执行事件
    - 客户端可向上发送控制指令 (如 `stop`)
    """
    await websocket.accept()
    try:
        session = mgr.get_session_by_agent_id(agent_id)
    except AgentSessionNotFoundError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="会话不存在")
        return

    queue = session.subscribe()

    async def sender():
        try:
            while True:
                event = await queue.get()
                await websocket.send_text(event.model_dump_json())
        except Exception:
            pass

    async def receiver():
        try:
            while True:
                text = await websocket.receive_text()
                data = json.loads(text)
                if data.get("action") == "stop":
                    session.request_stop()
        except Exception:
            pass

    sender_task = asyncio.create_task(sender())
    receiver_task = asyncio.create_task(receiver())

    done, pending = await asyncio.wait(
        [sender_task, receiver_task],
        return_when=asyncio.FIRST_COMPLETED,
    )

    for task in pending:
        task.cancel()

    session.unsubscribe(queue)
