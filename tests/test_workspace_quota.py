"""
工作区隔离与配额熔断测试套件
Workspace Isolation & Quota Circuit Breaker Tests
"""

import os
from pathlib import Path
import pytest

from app.core.exceptions import PathTraversalError, QuotaExceededError, SecurityException
from app.core.security import is_path_safe, sanitize_path
from app.workspace.manager import WorkspaceManager
from app.workspace.quota import assert_can_write, calculate_directory_size, inspect_quota


@pytest.fixture
def temp_workspace(tmp_path):
    manager = WorkspaceManager(base_dir=str(tmp_path))
    return manager, tmp_path


def test_workspace_creation_and_directory_structure(temp_workspace):
    mgr, base_dir = temp_workspace
    tenant_id = "tenant_demo"
    agent_id = "agent_001"

    info = mgr.create_workspace(tenant_id, agent_id, hard_quota_bytes=10 * 1024 * 1024)

    assert info.tenant_id == tenant_id
    assert info.agent_id == agent_id
    expected_path = base_dir / tenant_id / agent_id
    assert Path(info.workspace_path) == expected_path
    assert expected_path.exists()
    assert (expected_path / ".workspace_meta.json").exists()


def test_invalid_identifier_rejected(temp_workspace):
    mgr, _ = temp_workspace
    # 试图在租户或 Agent ID 中注入路径穿越字符
    with pytest.raises(SecurityException):
        mgr.get_workspace_dir("../evil_tenant", "agent_1")

    with pytest.raises(SecurityException):
        mgr.get_workspace_dir("tenant_1", "agent/../../sub")


def test_anti_path_traversal_enforcement(tmp_path):
    ws_root = tmp_path / "workspace_jail"
    ws_root.mkdir()

    # 1. 相对路径逃逸
    with pytest.raises(PathTraversalError):
        sanitize_path(ws_root, "../secret.txt")

    with pytest.raises(PathTraversalError):
        sanitize_path(ws_root, "sub/../../../../etc/passwd")

    # 2. 绝对路径外部逃逸
    with pytest.raises(PathTraversalError):
        sanitize_path(ws_root, "/etc/shadow")

    # 3. 正常工作区内部路径
    safe_target = sanitize_path(ws_root, "src/main.py")
    assert safe_target == (ws_root / "src/main.py").resolve()
    assert is_path_safe(ws_root, "src/main.py") is True
    assert is_path_safe(ws_root, "../../etc/passwd") is False


def test_storage_quota_calculation_and_circuit_breaker(temp_workspace):
    mgr, _ = temp_workspace
    tenant = "t_quota"
    agent = "a_quota"

    # 设置 100KB 硬配额，80KB 软配额
    hard_limit = 100 * 1024
    soft_limit = 80 * 1024
    info = mgr.create_workspace(tenant, agent, hard_quota_bytes=hard_limit, soft_quota_bytes=soft_limit)
    ws_path = Path(info.workspace_path)

    # 初始状态
    usage = mgr.get_quota(tenant, agent)
    assert usage.current_bytes >= 0
    assert not usage.is_hard_exceeded

    # 写入正常大小数据 (50KB)
    test_file = ws_path / "small.txt"
    test_file.write_bytes(b"A" * (50 * 1024))
    usage = mgr.get_quota(tenant, agent)
    assert usage.current_bytes >= 50 * 1024
    assert not usage.is_soft_exceeded
    assert not usage.is_hard_exceeded

    # 预写入检查：试图再写 60KB，预期累计 110KB > 100KB，必须触发熔断
    with pytest.raises(QuotaExceededError) as exc_info:
        assert_can_write(ws_path, 60 * 1024, hard_limit, soft_limit)
    assert "工作区存储配额熔断" in str(exc_info.value)


def test_clean_workspace(temp_workspace):
    mgr, _ = temp_workspace
    tenant = "t_clean"
    agent = "a_clean"

    info = mgr.create_workspace(tenant, agent)
    ws_path = Path(info.workspace_path)
    assert ws_path.exists()

    cleaned = mgr.clean_workspace(tenant, agent)
    assert cleaned is True
    assert not ws_path.exists()
