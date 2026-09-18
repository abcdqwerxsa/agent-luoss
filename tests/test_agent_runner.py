"""
Agent Loop 调度器与流式事件集成测试
Agent Loop Runner & Streaming Integration Tests
"""

import asyncio
from pathlib import Path
import pytest

from app.agent.models import AgentStatus, CreateTaskRequest, EventType, PlannedStep
from app.agent.runner import AgentRunner
from app.agent.session import AgentSessionManager
from app.workspace.manager import WorkspaceManager


@pytest.fixture
def isolated_runner(tmp_path, monkeypatch):
    ws_mgr = WorkspaceManager(base_dir=str(tmp_path / "workspaces"))
    sess_mgr = AgentSessionManager()
    runner = AgentRunner()

    monkeypatch.setattr("app.agent.runner.workspace_manager", ws_mgr)
    monkeypatch.setattr("app.agent.runner.session_manager", sess_mgr)
    monkeypatch.setattr("app.agent.session.session_manager", sess_mgr)

    return runner, sess_mgr, ws_mgr


@pytest.mark.asyncio
async def test_agent_loop_success_lifecycle_and_streaming(isolated_runner):
    runner, sess_mgr, ws_mgr = isolated_runner

    req = CreateTaskRequest(
        tenant_id="tenant_alpha",
        agent_id="agent_101",
        role="developer",
        prompt="测试编写脚本并执行",
        planned_steps=[
            PlannedStep(
                tool_name="write_file",
                arguments={"path": "hello.py", "content": "print('Agent loop executed!')\n"},
                thought="第一步：编写 Python 测试文件",
            ),
            PlannedStep(
                tool_name="execute_bash",
                arguments={"command": "python3 hello.py"},
                thought="第二步：执行刚才编写的脚本",
            ),
        ],
    )

    session = runner.start_task(req)
    queue = session.subscribe()

    collected_events = []
    # 等待 Agent Loop 运行并收集事件
    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=5.0)
            collected_events.append(event)
            if event.event_type == EventType.DONE:
                break
        except asyncio.TimeoutError:
            break

    # 验证生命周期终态
    assert session.status == AgentStatus.COMPLETED
    assert session.current_step == 2
    assert session.total_steps == 2

    # 验证捕获到的事件流
    event_types = [e.event_type for e in collected_events]
    assert EventType.THOUGHT in event_types
    assert EventType.TOOL_CALL_START in event_types
    assert EventType.TOOL_CALL_RESULT in event_types
    assert EventType.STDOUT in event_types
    assert EventType.DONE in event_types

    # 验证物理文件生成在工作区中
    ws_dir = ws_mgr.get_workspace_dir("tenant_alpha", "agent_101")
    assert (ws_dir / "hello.py").exists()


@pytest.mark.asyncio
async def test_agent_loop_quota_circuit_breaker(isolated_runner):
    runner, sess_mgr, ws_mgr = isolated_runner

    # 故意设置极小硬配额：5KB
    req = CreateTaskRequest(
        tenant_id="tenant_quota_break",
        agent_id="agent_small_quota",
        role="developer",
        prompt="测试配额超限熔断",
        hard_quota_bytes=5 * 1024,
        soft_quota_bytes=3 * 1024,
        planned_steps=[
            PlannedStep(
                tool_name="write_file",
                arguments={"path": "overflow.bin", "content": "X" * (10 * 1024)},
                thought="试图写入 10KB 文件以触发配额熔断",
            ),
        ],
    )

    session = runner.start_task(req)
    queue = session.subscribe()

    events = []
    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=5.0)
            events.append(event)
            if event.event_type in [EventType.QUOTA_ALERT, EventType.ERROR]:
                break
        except asyncio.TimeoutError:
            break

    # 稍作等待确保 session 状态更新
    await asyncio.sleep(0.1)

    assert session.status == AgentStatus.QUOTA_EXCEEDED
    assert any(e.event_type == EventType.QUOTA_ALERT for e in events)


@pytest.mark.asyncio
async def test_agent_stop_task(isolated_runner):
    runner, sess_mgr, _ = isolated_runner

    req = CreateTaskRequest(
        tenant_id="tenant_cancel",
        agent_id="agent_cancel",
        role="developer",
        prompt="测试长周期任务终止",
        planned_steps=[
            PlannedStep(
                tool_name="execute_bash",
                arguments={"command": "sleep 5"},
                thought="模拟长耗时命令",
            ),
        ],
    )

    session = runner.start_task(req)
    await asyncio.sleep(0.1)

    # 主动发送终止请求
    stop_ok = runner.stop_task("tenant_cancel", "agent_cancel")
    assert stop_ok is True

    await asyncio.sleep(0.2)
    assert session.status == AgentStatus.STOPPED
