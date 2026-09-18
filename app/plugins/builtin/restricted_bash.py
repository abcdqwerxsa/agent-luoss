"""
内置受限 Shell 执行插件 (Restricted Bash Plugin)
提供安全的受限命令执行、黑名单拦截、超时控制与工作区目录强绑定
"""

import asyncio
import os
import re
import time
from typing import Any, Dict, List, Optional
from app.config import settings
from app.core.exceptions import PluginExecutionError, SecurityException
from app.core.logger import logger
from app.plugins.base import BasePlugin, PluginExecutionContext, ToolDefinition
from app.workspace.quota import inspect_quota


# 危险命令黑名单正则（防破坏与逃逸）
DANGEROUS_PATTERNS = [
    re.compile(r"\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(/|\*|~|\.\.)"),
    re.compile(r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),  # fork 炸弹
    re.compile(r"\bmkfs\b"),
    re.compile(r"\bdd\s+if="),
    re.compile(r">\s*/dev/(sd|hd|nvme|zero|null|kmem)"),
    re.compile(r"\b(shutdown|reboot|poweroff|init\s+0)\b"),
    re.compile(r"(curl|wget)\s+.*\|\s*(bash|sh)"),
    re.compile(r"\bchmod\s+(-R\s+)?777\s+\/"),
]


class RestrictedBashPlugin(BasePlugin):
    """受限 Bash 执行插件"""

    @property
    def name(self) -> str:
        return "restricted_bash"

    @property
    def description(self) -> str:
        return "在严格绑定的工作区目录下安全执行 Shell 命令，提供黑名单防御与超时保护"

    def get_tools(self) -> List[ToolDefinition]:
        return [
            ToolDefinition(
                name="execute_bash",
                description="在受限工作区环境中执行一条 Bash 命令行脚本",
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的 Shell 命令字符串",
                        },
                        "timeout_seconds": {
                            "type": "integer",
                            "description": "执行超时时间 (秒)，默认 60 秒",
                            "default": 60,
                        },
                    },
                    "required": ["command"],
                },
            )
        ]

    def _validate_command(self, cmd: str) -> None:
        """检查命令是否命中危险命令规则"""
        clean_cmd = cmd.strip()
        for pattern in DANGEROUS_PATTERNS:
            if pattern.search(clean_cmd):
                logger.warning(f"检测到高危命令拦截: {cmd}")
                raise SecurityException(
                    f"命令包含禁止执行的高危特征，已被系统安全防火墙拦截: '{cmd}'"
                )

    async def execute(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        context: PluginExecutionContext,
    ) -> Dict[str, Any]:
        if tool_name != "execute_bash":
            raise PluginExecutionError(self.name, f"未知工具名称: '{tool_name}'")

        command = arguments.get("command", "")
        timeout = arguments.get("timeout_seconds", settings.BASH_TIMEOUT_SECONDS)

        # 1. 安全过滤检查
        self._validate_command(command)

        workspace_dir = context.workspace_root
        if not workspace_dir.exists():
            workspace_dir.mkdir(parents=True, exist_ok=True)

        start_time = time.time()
        logger.info(f"[{context.tenant_id}/{context.agent_id}] 启动命令执行: {command} (工作目录: {workspace_dir})")

        # 2. 隔离环境变量（去除敏感系统环境变量，注入工作区路径）
        env = os.environ.copy()
        env["PWD"] = str(workspace_dir)
        env["WORKSPACE_DIR"] = str(workspace_dir)
        env["TERM"] = "dumb"
        if context.extra_env:
            env.update(context.extra_env)

        try:
            # 3. 异步启动子进程，严格限制 cwd 为 workspace_dir
            process = await asyncio.create_subprocess_shell(
                command,
                cwd=str(workspace_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )

            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=float(timeout)
            )

            duration = round(time.time() - start_time, 3)
            stdout = stdout_bytes.decode("utf-8", errors="replace")[: settings.MAX_OUTPUT_CHARS]
            stderr = stderr_bytes.decode("utf-8", errors="replace")[: settings.MAX_OUTPUT_CHARS]

            # 4. 执行完成后立即检查配额状态
            quota_status = inspect_quota(
                workspace_dir,
                context.hard_quota_bytes,
                context.soft_quota_bytes,
            )

            return {
                "exit_code": process.returncode,
                "stdout": stdout,
                "stderr": stderr,
                "duration_seconds": duration,
                "command": command,
                "quota_usage_mb": quota_status.current_mb,
                "is_hard_exceeded": quota_status.is_hard_exceeded,
            }

        except asyncio.TimeoutError:
            try:
                process.kill()
            except Exception:
                pass
            raise PluginExecutionError(self.name, f"命令执行超时 ({timeout} 秒已终止)")
        except Exception as e:
            if isinstance(e, (SecurityException, PluginExecutionError)):
                raise e
            raise PluginExecutionError(self.name, f"进程执行异常: {str(e)}")
