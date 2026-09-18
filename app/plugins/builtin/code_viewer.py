"""
安全代码与文件操作插件 (Code Viewer & Editor Plugin)
提供工作区内的安全文件读取、写入、目录枚举与代码搜索，严格集成防穿越与配额熔断
"""

import os
from pathlib import Path
from typing import Any, Dict, List, Optional
import aiofiles

from app.config import settings
from app.core.exceptions import PluginExecutionError
from app.core.logger import logger
from app.core.security import sanitize_path
from app.plugins.base import BasePlugin, PluginExecutionContext, ToolDefinition
from app.workspace.quota import assert_can_write


class CodeViewerPlugin(BasePlugin):
    """安全代码查看与编辑器插件"""

    @property
    def name(self) -> str:
        return "code_viewer"

    @property
    def description(self) -> str:
        return "安全的代码与文件管理工具，支持受限工作区内的文件读写、目录列表与代码文本检索"

    def get_tools(self) -> List[ToolDefinition]:
        return [
            ToolDefinition(
                name="read_file",
                description="安全读取工作区中的指定文件内容，支持分行切片",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "工作区内的文件相对路径"},
                        "start_line": {"type": "integer", "description": "起始行号 (从 1 开始)", "default": 1},
                        "end_line": {"type": "integer", "description": "结束行号 (包含此行)", "default": None},
                    },
                    "required": ["path"],
                },
            ),
            ToolDefinition(
                name="write_file",
                description="在工作区中创建或覆盖指定文件，执行前自动进行存储配额熔断检查",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "工作区内的文件相对路径"},
                        "content": {"type": "string", "description": "要写入的文件文本内容"},
                        "overwrite": {"type": "boolean", "description": "若文件已存在是否覆盖", "default": True},
                    },
                    "required": ["path", "content"],
                },
            ),
            ToolDefinition(
                name="list_directory",
                description="安全列出工作区内指定目录的文件与子目录结构",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "工作区内的相对目录路径，默认根目录", "default": "."},
                        "max_depth": {"type": "integer", "description": "目录递归深度限制", "default": 3},
                    },
                },
            ),
            ToolDefinition(
                name="search_code",
                description="在工作区所有源代码文件中检索指定字符串模式",
                parameters={
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "检索关键字或字符串"},
                        "sub_dir": {"type": "string", "description": "检索的子目录路径，默认根目录", "default": "."},
                    },
                    "required": ["query"],
                },
            ),
        ]

    async def execute(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        context: PluginExecutionContext,
    ) -> Dict[str, Any]:
        ws_root = context.workspace_root

        if tool_name == "read_file":
            rel_path = arguments.get("path", "")
            target_path = sanitize_path(ws_root, rel_path)
            if not target_path.exists() or not target_path.is_file():
                raise PluginExecutionError(self.name, f"文件不存在或非普通文件: '{rel_path}'")

            start_line = arguments.get("start_line", 1) or 1
            end_line = arguments.get("end_line")

            async with aiofiles.open(target_path, "r", encoding="utf-8", errors="replace") as f:
                lines = await f.readlines()

            total_lines = len(lines)
            selected = lines[start_line - 1 : end_line if end_line else total_lines]
            return {
                "path": rel_path,
                "total_lines": total_lines,
                "content": "".join(selected),
                "start_line": start_line,
                "end_line": end_line or total_lines,
            }

        elif tool_name == "write_file":
            rel_path = arguments.get("path", "")
            content = arguments.get("content", "")
            overwrite = arguments.get("overwrite", True)

            target_path = sanitize_path(ws_root, rel_path)
            if target_path.exists() and not overwrite:
                raise PluginExecutionError(self.name, f"文件已存在且未开启覆盖: '{rel_path}'")

            content_bytes = content.encode("utf-8")
            # 写入前硬配额校验！
            assert_can_write(
                ws_root,
                incoming_bytes=len(content_bytes),
                hard_quota_bytes=context.hard_quota_bytes,
                soft_quota_bytes=context.soft_quota_bytes,
            )

            target_path.parent.mkdir(parents=True, exist_ok=True)
            async with aiofiles.open(target_path, "w", encoding="utf-8") as f:
                await f.write(content)

            return {
                "path": rel_path,
                "bytes_written": len(content_bytes),
                "status": "success",
            }

        elif tool_name == "list_directory":
            rel_path = arguments.get("path", ".")
            max_depth = arguments.get("max_depth", 3)
            target_dir = sanitize_path(ws_root, rel_path)

            if not target_dir.exists() or not target_dir.is_dir():
                raise PluginExecutionError(self.name, f"目录不存在: '{rel_path}'")

            items = []
            root_len = len(str(target_dir))
            for root, dirs, files in os.walk(target_dir):
                rel_sub = os.path.relpath(root, target_dir)
                depth = 0 if rel_sub == "." else len(rel_sub.split(os.sep))
                if depth >= max_depth:
                    dirs.clear()
                    continue

                for d in sorted(dirs):
                    items.append({"type": "directory", "path": os.path.join(rel_sub, d).lstrip("./")})
                for f in sorted(files):
                    items.append({"type": "file", "path": os.path.join(rel_sub, f).lstrip("./")})

            return {"base_path": rel_path, "items": items[:500]}

        elif tool_name == "search_code":
            query = arguments.get("query", "")
            sub_dir = arguments.get("sub_dir", ".")
            target_dir = sanitize_path(ws_root, sub_dir)

            matches = []
            for root, _, files in os.walk(target_dir):
                for file in files:
                    file_path = Path(root) / file
                    try:
                        # 仅搜索小于 5MB 的文本文件
                        if file_path.stat().st_size > 5 * 1024 * 1024:
                            continue
                        rel_file = str(file_path.relative_to(ws_root))
                        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                            for idx, line in enumerate(f, start=1):
                                if query in line:
                                    matches.append({
                                        "file": rel_file,
                                        "line_number": idx,
                                        "content": line.strip()[:200],
                                    })
                                    if len(matches) >= 100:
                                        break
                    except Exception:
                        continue
                if len(matches) >= 100:
                    break

            return {"query": query, "matches": matches, "total_matches": len(matches)}

        else:
            raise PluginExecutionError(self.name, f"未知工具名称: '{tool_name}'")
