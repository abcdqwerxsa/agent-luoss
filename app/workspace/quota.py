"""
工作区配额计算与熔断监控引擎
Workspace Quota Engine & Circuit Breaker
"""

import os
from pathlib import Path
from app.core.exceptions import QuotaExceededError
from app.core.logger import logger
from app.workspace.models import QuotaUsage


def calculate_directory_size(target_dir: Path) -> int:
    """
    快速递归计算目录内所有文件占用的物理字节数。
    忽略损坏的软链接并防止循环引用。
    """
    if not target_dir.exists():
        return 0

    total_size = 0
    try:
        for root, _, files in os.walk(target_dir, followlinks=False):
            for file in files:
                file_path = os.path.join(root, file)
                try:
                    # 使用 lstat 避免追踪外部软链接导致非本目录容量被统计
                    total_size += os.lstat(file_path).st_size
                except (OSError, FileNotFoundError):
                    continue
    except OSError as e:
        logger.warning(f"扫描目录大小异常 {target_dir}: {e}")

    return total_size


def inspect_quota(
    workspace_path: Path,
    hard_quota_bytes: int,
    soft_quota_bytes: int,
) -> QuotaUsage:
    """
    检查工作区当前存储配额使用状态并返回结构化用量对象。
    """
    current_bytes = calculate_directory_size(workspace_path)
    current_mb = round(current_bytes / (1024 * 1024), 3)
    hard_mb = round(hard_quota_bytes / (1024 * 1024), 3)
    soft_mb = round(soft_quota_bytes / (1024 * 1024), 3)

    ratio = round(current_bytes / hard_quota_bytes, 4) if hard_quota_bytes > 0 else 0.0
    is_soft = current_bytes >= soft_quota_bytes
    is_hard = current_bytes >= hard_quota_bytes

    return QuotaUsage(
        current_bytes=current_bytes,
        current_mb=current_mb,
        hard_quota_bytes=hard_quota_bytes,
        hard_quota_mb=hard_mb,
        soft_quota_bytes=soft_quota_bytes,
        soft_quota_mb=soft_mb,
        usage_ratio=ratio,
        is_soft_exceeded=is_soft,
        is_hard_exceeded=is_hard,
    )


def assert_can_write(
    workspace_path: Path,
    incoming_bytes: int,
    hard_quota_bytes: int,
    soft_quota_bytes: int,
) -> None:
    """
    写入前配额熔断断言：
    在执行写入、克隆、编译等生成操作前，先校验当前容量 + 新增容量是否突破硬配额。
    若超限，立即抛出 QuotaExceededError 触发熔断。
    """
    current_bytes = calculate_directory_size(workspace_path)
    estimated_total = current_bytes + incoming_bytes

    if estimated_total >= hard_quota_bytes:
        logger.error(
            f"配额熔断触发！工作区: {workspace_path}, 当前: {current_bytes} B, "
            f"预写入: {incoming_bytes} B, 上限: {hard_quota_bytes} B"
        )
        raise QuotaExceededError(
            current_bytes=estimated_total,
            max_bytes=hard_quota_bytes,
            path=str(workspace_path),
        )

    if estimated_total >= soft_quota_bytes:
        logger.warning(
            f"工作区软配额告警: {workspace_path} (占用已达 {(estimated_total / hard_quota_bytes) * 100:.1f}%)"
        )
