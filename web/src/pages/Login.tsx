import React, { useState } from "react";
import { api } from "../lib/api";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await api.login(username, password);
      api && auth_save(r.access_token, r.refresh_token, r.user);
      onLogin();
    } catch (e: any) {
      setErr(e.message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>AgentLuoss</h1>
        <p className="sub">企业通用智能体平台</p>
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

import { auth } from "../lib/api";
function auth_save(a: string, b: string, u: any) { auth.save(a, b, u); }
