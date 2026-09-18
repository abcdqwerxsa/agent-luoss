"""
安全 Git 版本控制插件 (Git Committer Plugin)
提供工作区内的 Git 仓库初始化、状态查询、差异比对、代码提交与日志追踪
"""

import asyncio
import os
from typing import Any, Dict, List, Optional
from app.core.exceptions import PluginExecutionError
from app.core.logger import logger
from app.plugins.base import BasePlugin, PluginExecutionContext, ToolDefinition


class GitCommitterPlugin(BasePlugin):
    """安全 Git 操作插件"""

    @property
    def name(self) -> str:
        return "git_committer"

    @property
    def description(self) -> str:
        return "在独立工作区中提供安全的 Git 仓库初始化、状态追踪、代码提交与变更日志检索"

    def get_tools(self) -> List[ToolDefinition]:
        return [
            ToolDefinition(
                name="git_init",
                description="在工作区根目录下初始化一个全新的 Git 仓库",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="git_status",
                description="查询当前工作区的 Git 文件修改状态",
                parameters={"type": "object", "properties": {}},
            ),
            ToolDefinition(
                name="git_diff",
                description="获取当前工作区中未提交或暂存的代码差异 (diff)",
                parameters={
                    "type": "object",
                    "properties": {
                        "staged": {
                            "type": "boolean",
                            "description": "是否查看暂存区 (--staged) 的差异",
                            "default": False,
                        }
                    },
                },
            ),
            ToolDefinition(
                name="git_commit",
                description="将当前工作区的文件变更加载并提交到 Git 仓库",
                parameters={
                    "type": "object",
                    "properties": {
                        "message": {"type": "string", "description": "提交信息 (Commit message)"},
                        "add_all": {"type": "boolean", "description": "是否自动执行 git add -A", "default": True},
                    },
                    "required": ["message"],
                },
            ),
            ToolDefinition(
                name="git_log",
                description="查询 Git 提交历史日志",
                parameters={
                    "type": "object",
                    "properties": {
                        "limit": {"type": "integer", "description": "展示最近几条日志记录", "default": 10},
                    },
                },
            ),
        ]

    async def _run_git_cmd(self, ws_dir: str, args: List[str]) -> tuple[int, str, str]:
        """在工作区内安全执行 git 子命令"""
        env = os.environ.copy()
        # 预设 committer/author 保证内网无全局 git config 也能顺利提交
        env["GIT_AUTHOR_NAME"] = "Agent-Luoss"
        env["GIT_AUTHOR_EMAIL"] = "agent@internal.local"
        env["GIT_COMMITTER_NAME"] = "Agent-Luoss"
        env["GIT_COMMITTER_EMAIL"] = "agent@internal.local"

        proc = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=ws_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout_b, stderr_b = await proc.communicate()
        return (
            proc.returncode or 0,
            stdout_b.decode("utf-8", errors="replace"),
            stderr_b.decode("utf-8", errors="replace"),
        )

    async def execute(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        context: PluginExecutionContext,
    ) -> Dict[str, Any]:
        ws_dir = str(context.workspace_root)

        if tool_name == "git_init":
            code, out, err = await self._run_git_cmd(ws_dir, ["init", "-b", "main"])
            if code != 0:
                # 兼容旧版本 git
                code, out, err = await self._run_git_cmd(ws_dir, ["init"])
            return {"status": "success" if code == 0 else "error", "output": (out + err).strip()}

        elif tool_name == "git_status":
            code, out, err = await self._run_git_cmd(ws_dir, ["status", "--short", "-b"])
            return {"status": "success" if code == 0 else "error", "output": (out + err).strip()}

        elif tool_name == "git_diff":
            staged = arguments.get("staged", False)
            cmd = ["diff", "--staged"] if staged else ["diff"]
            code, out, err = await self._run_git_cmd(ws_dir, cmd)
            return {"diff": out, "stderr": err, "status": "success" if code == 0 else "error"}

        elif tool_name == "git_commit":
            message = arguments.get("message", "update by agent")
            add_all = arguments.get("add_all", True)
            if add_all:
                await self._run_git_cmd(ws_dir, ["add", "-A"])
            code, out, err = await self._run_git_cmd(ws_dir, ["commit", "-m", message])
            return {"status": "success" if code == 0 else "error", "output": (out + err).strip()}

        elif tool_name == "git_log":
            limit = arguments.get("limit", 10)
            code, out, err = await self._run_git_cmd(
                ws_dir,
                ["log", f"-n{limit}", "--pretty=format:%h - %an, %ar : %s"],
            )
            return {"status": "success" if code == 0 else "error", "logs": out.splitlines()}

        else:
            raise PluginExecutionError(self.name, f"未知工具名称: '{tool_name}'")
