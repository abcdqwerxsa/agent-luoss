"""
插件功能与 RBAC 权限拦截测试套件
Plugins Functionality & RBAC Interception Tests
"""

from pathlib import Path
import pytest

from app.core.exceptions import PluginExecutionError, RBACPermissionError, SecurityException
from app.plugins.base import PluginExecutionContext
from app.plugins.builtin import CodeViewerPlugin, GitCommitterPlugin, RestrictedBashPlugin
from app.plugins.registry import PluginRegistry


@pytest.fixture
def test_env(tmp_path):
    registry = PluginRegistry()
    context = PluginExecutionContext(
        tenant_id="tenant_test",
        agent_id="agent_test",
        workspace_root=tmp_path,
        role="developer",
    )
    return registry, context, tmp_path


@pytest.mark.asyncio
async def test_plugin_rbac_enforcement(test_env):
    registry, context, _ = test_env

    # 1. developer 角色允许使用 restricted_bash
    context.role = "developer"
    res = await registry.dispatch(
        tool_name="execute_bash",
        arguments={"command": "echo 'Hello RBAC'"},
        context=context,
    )
    assert res["exit_code"] == 0
    assert "Hello RBAC" in res["stdout"]

    # 2. viewer 角色被限制，禁止使用 restricted_bash
    context.role = "viewer"
    with pytest.raises(RBACPermissionError) as exc_info:
        await registry.dispatch(
            tool_name="execute_bash",
            arguments={"command": "echo 'Blocked'"},
            context=context,
        )
    assert "未被授权" in str(exc_info.value)

    # 3. 动态配置 RBAC 白名单，向 viewer 角色授予 restricted_bash
    registry.update_role_permissions("viewer", ["code_viewer", "restricted_bash"])
    res2 = await registry.dispatch(
        tool_name="execute_bash",
        arguments={"command": "echo 'Granted'"},
        context=context,
    )
    assert res2["exit_code"] == 0
    assert "Granted" in res2["stdout"]


@pytest.mark.asyncio
async def test_code_viewer_plugin(test_env):
    _, context, ws_root = test_env
    plugin = CodeViewerPlugin()

    # 1. 写入文件
    write_res = await plugin.execute(
        tool_name="write_file",
        arguments={"path": "src/app.py", "content": "print('hello world')\nx = 42\n"},
        context=context,
    )
    assert write_res["status"] == "success"
    assert (ws_root / "src" / "app.py").exists()

    # 2. 读取文件
    read_res = await plugin.execute(
        tool_name="read_file",
        arguments={"path": "src/app.py", "start_line": 1, "end_line": 1},
        context=context,
    )
    assert read_res["content"].strip() == "print('hello world')"
    assert read_res["total_lines"] == 2

    # 3. 列出目录
    list_res = await plugin.execute(
        tool_name="list_directory",
        arguments={"path": "."},
        context=context,
    )
    paths = [item["path"] for item in list_res["items"]]
    assert any("app.py" in p for p in paths)

    # 4. 检索代码
    search_res = await plugin.execute(
        tool_name="search_code",
        arguments={"query": "hello world"},
        context=context,
    )
    assert search_res["total_matches"] >= 1
    assert search_res["matches"][0]["file"] == "src/app.py"


@pytest.mark.asyncio
async def test_restricted_bash_security_firewall(test_env):
    _, context, _ = test_env
    plugin = RestrictedBashPlugin()

    # 1. 拦截高危命令 (rm -rf /)
    with pytest.raises(SecurityException) as exc:
        await plugin.execute(
            tool_name="execute_bash",
            arguments={"command": "rm -rf /"},
            context=context,
        )
    assert "高危特征" in str(exc.value)

    # 2. 正常受限命令执行
    res = await plugin.execute(
        tool_name="execute_bash",
        arguments={"command": "pwd"},
        context=context,
    )
    assert res["exit_code"] == 0
    # 确认执行所在目录为隔离工作区
    assert str(context.workspace_root) in res["stdout"].strip()


@pytest.mark.asyncio
async def test_git_committer_plugin(test_env):
    _, context, ws_root = test_env
    plugin = GitCommitterPlugin()

    # 1. git init
    init_res = await plugin.execute("git_init", {}, context)
    assert init_res["status"] == "success"
    assert (ws_root / ".git").exists()

    # 2. 写入文件并提交
    test_file = ws_root / "sample.py"
    test_file.write_text("# initial", encoding="utf-8")

    commit_res = await plugin.execute(
        "git_commit",
        {"message": "feat: initial commit", "add_all": True},
        context,
    )
    assert commit_res["status"] == "success"

    # 3. git status
    status_res = await plugin.execute("git_status", {}, context)
    assert status_res["status"] == "success"

    # 4. git log
    log_res = await plugin.execute("git_log", {"limit": 1}, context)
    assert len(log_res["logs"]) >= 1
    assert "feat: initial commit" in log_res["logs"][0]
