"""
Agent-Loop 调度器与核心执行引擎
Agent Loop Scheduler and Execution Engine
"""

import asyncio
from pathlib import Path
from typing import Optional
from app.agent.models import (
    AgentStatus,
    CreateTaskRequest,
    EventType,
    PlannedStep,
)
from app.agent.pi_adapter import pi_adapter
from app.agent.session import AgentSession, session_manager
from app.core.exceptions import (
    PathTraversalError,
    QuotaExceededError,
    RBACPermissionError,
    SecurityException,
)
from app.core.logger import logger
from app.plugins.base import PluginExecutionContext
from app.workspace.manager import workspace_manager


class AgentRunner:
    """负责驱动单个 Agent 任务的完整生命周期循环与实时事件流"""

    def __init__(self):
        self._running_tasks: dict[str, asyncio.Task] = {}

    def start_task(self, req: CreateTaskRequest) -> AgentSession:
        """初始化并启动异步 Agent Loop 任务"""
        session = session_manager.create_session(
            tenant_id=req.tenant_id,
            agent_id=req.agent_id,
            role=req.role,
        )

        task = asyncio.create_task(
            self._execute_agent_loop(req, session),
            name=f"agent_loop_{req.tenant_id}_{req.agent_id}",
        )
        self._running_tasks[f"{req.tenant_id}:{req.agent_id}"] = task
        return session

    def stop_task(self, tenant_id: str, agent_id: str) -> bool:
        """请求停止正在执行的 Agent Loop 任务"""
        try:
            session = session_manager.get_session(tenant_id, agent_id)
            session.request_stop()
            key = f"{tenant_id}:{agent_id}"
            if key in self._running_tasks:
                self._running_tasks[key].cancel()
            return True
        except Exception as e:
            logger.warning(f"停止任务失败: {e}")
            return False

    async def _execute_agent_loop(self, req: CreateTaskRequest, session: AgentSession):
        """
        核心 Agent Loop 生命周期实现：
        1. Init: 校验配额、挂载工作区、注入插件元数据
        2. Step: 循环规划、工具调用、思考捕获、命令标准流推送
        3. Stream: 实时广播事件至 SSE / WebSocket
        """
        tenant_id = req.tenant_id
        agent_id = req.agent_id
        role = req.role

        try:
            # ======================== 阶段 1: Init ========================
            session.update_status(AgentStatus.INITIALIZING)
            session.emit(
                EventType.THOUGHT,
                {"thought": f"正在初始化工作区环境 (租户={tenant_id}, 角色={role})..."},
            )

            # 初始化或挂载工作区
            ws_info = workspace_manager.create_workspace(
                tenant_id=tenant_id,
                agent_id=agent_id,
                hard_quota_bytes=req.hard_quota_bytes,
                soft_quota_bytes=req.soft_quota_bytes,
            )
            ws_path = Path(ws_info.workspace_path)

            # 校验当前初始配额状态
            quota = workspace_manager.get_quota(tenant_id, agent_id)
            if quota.is_hard_exceeded:
                raise QuotaExceededError(
                    current_bytes=quota.current_bytes,
                    max_bytes=quota.hard_quota_bytes,
                    path=str(ws_path),
                )

            # 导出与注入插件上下文与工具清单
            tools_schema = pi_adapter.export_tools_schema_for_pi(role)
            session.emit(
                EventType.THOUGHT,
                {
                    "thought": f"工作区挂载成功，路径: {ws_path}。当前配额上限: {quota.hard_quota_mb}MB，"
                    f"已授权工具数量: {len(tools_schema)} 个。"
                },
            )

            context = PluginExecutionContext(
                tenant_id=tenant_id,
                agent_id=agent_id,
                workspace_root=ws_path,
                role=role,
                hard_quota_bytes=ws_info.hard_quota_bytes,
                soft_quota_bytes=ws_info.soft_quota_bytes,
            )

            session.update_status(AgentStatus.RUNNING)

            # ======================== 阶段 2: Step Loop ========================
            steps: list[PlannedStep] = req.planned_steps or self._default_plan_from_prompt(req.prompt)
            session.total_steps = len(steps)

            for idx, step in enumerate(steps, start=1):
                if session.is_stop_requested():
                    logger.info(f"[{tenant_id}/{agent_id}] 检测到任务终止信号，提前中断 Loop")
                    session.update_status(AgentStatus.STOPPED)
                    return

                session.current_step = idx

                # 1. 思考过程流式推送
                thought_text = step.thought or f"执行步骤 {idx}/{len(steps)}: 正在调用工具 '{step.tool_name}'..."
                session.emit(EventType.THOUGHT, {"step": idx, "thought": thought_text})

                # 2. 检查配额熔断（防止前置步骤产生超大文件）
                current_quota = workspace_manager.get_quota(tenant_id, agent_id)
                if current_quota.is_hard_exceeded:
                    raise QuotaExceededError(
                        current_bytes=current_quota.current_bytes,
                        max_bytes=current_quota.hard_quota_bytes,
                        path=str(ws_path),
                    )
                if current_quota.is_soft_exceeded:
                    session.emit(
                        EventType.QUOTA_ALERT,
                        {
                            "level": "warning",
                            "message": f"当前工作区已达软配额阈值 ({current_quota.current_mb}MB / {current_quota.hard_quota_mb}MB)",
                        },
                    )

                # 3. 广播工具调用开始
                session.emit(
                    EventType.TOOL_CALL_START,
                    {
                        "step": idx,
                        "tool_name": step.tool_name,
                        "arguments": step.arguments,
                    },
                )

                # 4. 执行工具调用 (经由 pi_adapter & plugin_registry 鉴权)
                tool_result = await pi_adapter.execute_tool_call(
                    tool_name=step.tool_name,
                    arguments=step.arguments,
                    context=context,
                )

                # 5. 标准输出流式捕获
                if "stdout" in tool_result and tool_result["stdout"]:
                    session.emit(EventType.STDOUT, {"step": idx, "text": tool_result["stdout"]})
                if "stderr" in tool_result and tool_result["stderr"]:
                    session.emit(EventType.STDERR, {"step": idx, "text": tool_result["stderr"]})

                # 6. 广播工具执行结果
                session.emit(
                    EventType.TOOL_CALL_RESULT,
                    {
                        "step": idx,
                        "tool_name": step.tool_name,
                        "result": tool_result,
                    },
                )

                # 短暂让出协程保证高吞吐流式网络 I/O 调度
                await asyncio.sleep(0.01)

            # ======================== 阶段 3: Finish ========================
            session.emit(
                EventType.THOUGHT,
                {"thought": "所有编排步骤均已顺利执行完毕，任务顺利达成。"},
            )
            session.emit(EventType.DONE, {"status": "success", "steps_executed": len(steps)})
            session.update_status(AgentStatus.COMPLETED)

        except asyncio.CancelledError:
            logger.info(f"[{tenant_id}/{agent_id}] 任务协程被取消")
            session.update_status(AgentStatus.STOPPED, error_msg="任务已被主动终止")
        except QuotaExceededError as qe:
            logger.error(f"[{tenant_id}/{agent_id}] 配额超限熔断: {qe.message}")
            workspace_manager.freeze_workspace(tenant_id, agent_id, reason="quota_exceeded")
            session.emit(
                EventType.QUOTA_ALERT,
                {"level": "critical", "message": qe.message, "details": qe.details},
            )
            session.update_status(AgentStatus.QUOTA_EXCEEDED, error_msg=qe.message)
        except (SecurityException, RBACPermissionError, PathTraversalError) as se:
            logger.error(f"[{tenant_id}/{agent_id}] 安全或权限拦截: {se.message}")
            session.emit(
                EventType.ERROR,
                {"level": "security_violation", "message": se.message, "details": getattr(se, "details", None)},
            )
            session.update_status(AgentStatus.FAILED, error_msg=se.message)
        except Exception as e:
            logger.exception(f"[{tenant_id}/{agent_id}] Agent Loop 运行时未知异常: {e}")
            session.emit(EventType.ERROR, {"level": "fatal", "message": str(e)})
            session.update_status(AgentStatus.FAILED, error_msg=str(e))
        finally:
            key = f"{tenant_id}:{agent_id}"
            if key in self._running_tasks:
                del self._running_tasks[key]

    def _default_plan_from_prompt(self, prompt: str) -> list[PlannedStep]:
        """
        若无显式步骤列表，根据提示词自动推导基础执行管道
        （用于开箱即用快速验证或无外部大模型时的通用工程步骤）
        """
        return [
            PlannedStep(
                tool_name="read_file",
                arguments={"path": "README.md"},
                thought="检查工作区当前工程结构与现有文件...",
            ),
            PlannedStep(
                tool_name="write_file",
                arguments={
                    "path": "task_summary.txt",
                    "content": f"Agent 执行目标: {prompt}\n状态: 正在按工程规划安全构建...\n",
                },
                thought="记录本次任务目标至 task_summary.txt...",
            ),
            PlannedStep(
                tool_name="execute_bash",
                arguments={"command": "ls -la"},
                thought="执行目录校验，核查已生成文件清单...",
            ),
        ]


agent_runner = AgentRunner()
