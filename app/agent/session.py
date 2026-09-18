"""
Agent 会话管理与流式事件广播总线
Agent Session Manager and Event Streaming Bus
"""

import asyncio
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set
from app.agent.models import AgentEvent, AgentStatus, EventType
from app.core.exceptions import AgentSessionNotFoundError
from app.core.logger import logger


class AgentSession:
    """单个 Agent 运行时的上下文会话与事件分发中心"""

    def __init__(self, tenant_id: str, agent_id: str, role: str):
        self.tenant_id = tenant_id
        self.agent_id = agent_id
        self.role = role
        self.status = AgentStatus.INITIALIZING
        self.created_at = datetime.now(timezone.utc)
        self.updated_at = datetime.now(timezone.utc)
        self.current_step = 0
        self.total_steps = 0
        self.error_message: Optional[str] = None

        # 异步事件广播监听队列集合
        self._subscribers: Set[asyncio.Queue[AgentEvent]] = set()
        # 事件历史记录（支持断线补发）
        self.history: List[AgentEvent] = []
        # 中止信号事件
        self._stop_event = asyncio.Event()

    def update_status(self, new_status: AgentStatus, error_msg: Optional[str] = None):
        """更新会话状态并广播变更事件"""
        self.status = new_status
        self.updated_at = datetime.now(timezone.utc)
        if error_msg:
            self.error_message = error_msg

        self.emit(
            EventType.STATUS_CHANGE,
            {"status": new_status.value, "error": error_msg},
        )

    def is_stop_requested(self) -> bool:
        return self._stop_event.is_set()

    def request_stop(self):
        """标记停止信号"""
        self._stop_event.set()
        logger.info(f"[{self.tenant_id}/{self.agent_id}] 收到停止请求信号")

    def subscribe(self) -> asyncio.Queue[AgentEvent]:
        """为新的 SSE 或 WebSocket 客户端订阅一个事件通道"""
        queue: asyncio.Queue[AgentEvent] = asyncio.Queue()
        # 补发历史事件
        for evt in self.history:
            queue.put_nowait(evt)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[AgentEvent]):
        """移除订阅"""
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    def emit(self, event_type: EventType, payload: Dict):
        """生成事件并向所有活跃的订阅端广播"""
        evt = AgentEvent(
            agent_id=self.agent_id,
            tenant_id=self.tenant_id,
            event_type=event_type,
            payload=payload,
        )
        self.history.append(evt)

        # 广播至所有订阅队列
        dead_queues = []
        for q in self._subscribers:
            try:
                q.put_nowait(evt)
            except Exception:
                dead_queues.append(q)

        for dq in dead_queues:
            self._subscribers.discard(dq)


class AgentSessionManager:
    """全局 Agent 会话池管理器"""

    def __init__(self):
        self._sessions: Dict[str, AgentSession] = {}

    def _session_key(self, tenant_id: str, agent_id: str) -> str:
        return f"{tenant_id}:{agent_id}"

    def create_session(self, tenant_id: str, agent_id: str, role: str) -> AgentSession:
        key = self._session_key(tenant_id, agent_id)
        session = AgentSession(tenant_id, agent_id, role)
        self._sessions[key] = session
        return session

    def get_session(self, tenant_id: str, agent_id: str) -> AgentSession:
        key = self._session_key(tenant_id, agent_id)
        if key not in self._sessions:
            raise AgentSessionNotFoundError(agent_id)
        return self._sessions[key]

    def get_session_by_agent_id(self, agent_id: str) -> AgentSession:
        for session in self._sessions.values():
            if session.agent_id == agent_id:
                return session
        raise AgentSessionNotFoundError(agent_id)

    def remove_session(self, tenant_id: str, agent_id: str):
        key = self._session_key(tenant_id, agent_id)
        if key in self._sessions:
            del self._sessions[key]


session_manager = AgentSessionManager()
