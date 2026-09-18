"""
API 接口测试套件 (RESTful, SSE, WebSocket)
FastAPI REST, SSE and WebSocket Endpoint Tests
"""

import pytest
from httpx import ASGITransport, AsyncClient
from app.main import app


@pytest.mark.asyncio
async def test_health_check_endpoint():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["app"] == "Agent-Luoss"


@pytest.mark.asyncio
async def test_workspace_crud_flow():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 1. 创建工作区
        create_res = await ac.post(
            "/api/v1/workspaces",
            json={
                "tenant_id": "tenant_api_test",
                "agent_id": "agent_api_test",
                "hard_quota_bytes": 10 * 1024 * 1024,
            },
        )
        assert create_res.status_code == 201
        ws = create_res.json()
        assert ws["tenant_id"] == "tenant_api_test"
        assert ws["status"] == "active"

        # 2. 查询工作区详情
        get_res = await ac.get("/api/v1/workspaces/tenant_api_test/agent_api_test")
        assert get_res.status_code == 200
        assert get_res.json()["hard_quota_bytes"] == 10 * 1024 * 1024

        # 3. 查询配额
        quota_res = await ac.get("/api/v1/workspaces/tenant_api_test/agent_api_test/quota")
        assert quota_res.status_code == 200
        q = quota_res.json()
        assert q["hard_quota_mb"] == 10.0
        assert q["is_hard_exceeded"] is False

        # 4. 删除清理
        del_res = await ac.delete("/api/v1/workspaces/tenant_api_test/agent_api_test")
        assert del_res.status_code == 200


@pytest.mark.asyncio
async def test_plugins_and_rbac_api():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 1. 查询所有插件
        res = await ac.get("/api/v1/plugins")
        assert res.status_code == 200
        plugins = res.json()["plugins"]
        plugin_names = [p["name"] for p in plugins]
        assert "restricted_bash" in plugin_names
        assert "code_viewer" in plugin_names
        assert "git_committer" in plugin_names

        # 2. 查询当前 RBAC
        rbac_res = await ac.get("/api/v1/plugins/rbac")
        assert rbac_res.status_code == 200
        assert "developer" in rbac_res.json()["policies"]

        # 3. 动态配置 RBAC
        update_res = await ac.post(
            "/api/v1/plugins/rbac",
            json={
                "role": "custom_auditor",
                "allowed_plugins": ["code_viewer"],
            },
        )
        assert update_res.status_code == 200

        # 4. 查询特定角色允许的工具
        role_tools = await ac.get("/api/v1/plugins/roles/custom_auditor/tools")
        assert role_tools.status_code == 200
        tools = role_tools.json()["tools"]
        assert all(t["name"] in ["read_file", "write_file", "list_directory", "search_code"] for t in tools)


@pytest.mark.asyncio
async def test_agent_task_lifecycle_api():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 提交 Agent 任务
        submit_res = await ac.post(
            "/api/v1/agents/tasks",
            json={
                "tenant_id": "tenant_api_agent",
                "agent_id": "agent_api_01",
                "role": "developer",
                "prompt": "快速自动化构建与测试",
                "planned_steps": [
                    {
                        "tool_name": "execute_bash",
                        "arguments": {"command": "echo 'Testing API Agent'"},
                        "thought": "执行 echo 测试",
                    }
                ],
            },
        )
        assert submit_res.status_code == 202
        task = submit_res.json()
        assert task["agent_id"] == "agent_api_01"

        # 查询状态
        status_res = await ac.get("/api/v1/agents/tenant_api_agent/agent_api_01/status")
        assert status_res.status_code == 200
        assert status_res.json()["agent_id"] == "agent_api_01"
