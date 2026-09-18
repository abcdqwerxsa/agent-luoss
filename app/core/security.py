"""
安全工具库与路径防穿越校验引擎
Security Utilities and Anti-Path Traversal Engine
"""

import os
from pathlib import Path
from app.core.exceptions import PathTraversalError


def sanitize_path(workspace_root: str | Path, target_path: str | Path) -> Path:
    """
    严格校验并解析路径，杜绝任何路径穿越攻击（如 ../、软链接越界、绝对路径逃逸）。

    :param workspace_root: 允许访问的工作区根目录（基准目录）
    :param target_path: 目标相对路径或试图访问的绝对路径
    :return: 规范化解析后的安全 Path 对象
    :raises PathTraversalError: 当目标路径企图逃逸出工作区根目录时抛出
    """
    # 转为 Path 并解析物理真实路径（消除软链接与符号链接风险）
    abs_workspace = Path(workspace_root).resolve()

    target = Path(target_path)
    if target.is_absolute():
        # 如果是绝对路径，检查其是否显式位于 workspace_root 之下
        candidate = target.resolve()
    else:
        # 如果是相对路径，拼接在 workspace 根目录下后进行物理路径解析
        candidate = (abs_workspace / target).resolve()

    # 核心判断：利用 os.path.commonpath 确保公共根完全等于 abs_workspace
    try:
        common = os.path.commonpath([str(abs_workspace), str(candidate)])
    except ValueError:
        # Windows / 跨驱动器等情况
        raise PathTraversalError(str(target_path), str(abs_workspace))

    if common != str(abs_workspace):
        raise PathTraversalError(str(target_path), str(abs_workspace))

    return candidate


def is_path_safe(workspace_root: str | Path, target_path: str | Path) -> bool:
    """
    无异常抛出的安全检测辅助函数
    """
    try:
        sanitize_path(workspace_root, target_path)
        return True
    except PathTraversalError:
        return False
