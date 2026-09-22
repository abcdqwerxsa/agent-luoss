import React, { useState } from "react";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { ThemeToggle } from "../lib/theme";

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
      <div className="login-theme-toggle"><ThemeToggle /></div>
      <div className="login-brand">
        <div className="login-brand-head">
          <span className="brand-logo"><img src="/logo.svg" alt="ailswork" /></span>
          <span className="brand-name">ailswork</span>
        </div>
        <div className="login-hero">
          <span className="login-tag">企业通用智能体平台</span>
          <h1>把任务交给智能体，<br />你只看结果。</h1>
          <p className="sub">基于 pi Agent 内核与 Golang 微服务的任务式智能体平台 —— 会话执行、过程可视、产物交付、多模型调度、企业级管控。</p>
          <ul className="login-feats">
            <li>
              <span className="feat-icon"><Icon name="sliders-horizontal" size={16} /></span>
              <div><div className="feat-title">三种执行模式</div><div className="feat-desc">问一问只读 · 做一做直执 · 想一想先计划</div></div>
            </li>
            <li>
              <span className="feat-icon"><Icon name="folder" size={16} /></span>
              <div><div className="feat-title">工作区与产物</div><div className="feat-desc">每用户独立工作区，文件树浏览与下载</div></div>
            </li>
            <li>
              <span className="feat-icon"><Icon name="shield-check" size={16} /></span>
              <div><div className="feat-title">企业管控</div><div className="feat-desc">RBAC · 用量配额 · 全链路审计</div></div>
            </li>
          </ul>
        </div>
        <div className="login-meta">
          <span>gRPC 微服务</span><span>SSE 实时流</span><span>多模型网关</span><span>审计合规</span>
        </div>
      </div>
      <div className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div>
            <h1>登录</h1>
            <p className="sub">登录后进入你的智能体工作台</p>
          </div>
          <div className="login-fields">
            <div className="field">
              <label htmlFor="login-username">用户名</label>
              <div className="input-box">
                <Icon name="user" size={14} />
                <input id="login-username" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
              </div>
            </div>
            <div className="field">
              <label htmlFor="login-password">密码</label>
              <div className="input-box">
                <Icon name="lock" size={14} />
                <input id="login-password" placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>
          </div>
          {err && <div className="error">{err}</div>}
          <button className="btn primary" disabled={busy || !username || !password}>
            {busy ? "登录中…" : "登录"}
          </button>
          <div className="login-hint">
            <Icon name="info" size={12} />
            首次部署用初始化管理员账号登录，可在管理后台创建用户
          </div>
        </form>
      </div>
    </div>
  );
}

import { auth } from "../lib/api";
function auth_save(a: string, b: string, u: any) { auth.save(a, b, u); }
