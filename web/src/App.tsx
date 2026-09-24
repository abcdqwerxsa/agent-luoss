import React, { useEffect, useState } from "react";
import { api, auth } from "./lib/api";
import { Icon } from "./lib/icons";
import { ThemeToggle } from "./lib/theme";
import { Login } from "./pages/Login";
import { Tasks } from "./pages/Tasks";
import { Experts } from "./pages/Experts";
import { Knowledge } from "./pages/Knowledge";
import { TaskDetail } from "./pages/TaskDetail";
import { Admin } from "./pages/Admin";
import { ErrorBoundary } from "./components/ErrorBoundary";

// hash router: #/tasks, #/task/<id>, #/experts, #/knowledge, #/admin
function useHashRoute(): string {
  const [hash, setHash] = useState(() => location.hash || "#/tasks");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/tasks");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const route = useHashRoute();
  const [logged, setLogged] = useState(!!auth.token);

  if (!logged) {
    return <Login onLogin={() => setLogged(true)} />;
  }

  const user = auth.user;
  const nav = (
    <nav className="topnav">
      <a href="#/tasks" className="brand">
        <span className="brand-logo"><img src="/logo.svg" alt="ailswork" /></span>
        <span className="brand-name">ailswork</span>
      </a>
      <div className="nav-links">
        <a href="#/tasks" className={`nav-link ${route.startsWith("#/tasks") || route.startsWith("#/task/") ? "active" : ""}`}>任务</a>
        <a href="#/experts" className={`nav-link ${route.startsWith("#/experts") ? "active" : ""}`}>专家</a>
        <a href="#/knowledge" className={`nav-link ${route.startsWith("#/knowledge") ? "active" : ""}`}>知识库</a>
        {user?.role === "admin" && <a href="#/admin" className={`nav-link ${route.startsWith("#/admin") ? "active" : ""}`}>管理</a>}
      </div>
      <span className="spacer" />
      <ThemeToggle />
      <div className="who">
        <span>{user?.display_name || user?.username} · {user?.role}</span>
        <span className="avatar">{(user?.display_name || user?.username || "U")[0].toUpperCase()}</span>
        <button
          className="btn ghost sm"
          onClick={async () => {
            try { await api.logout(); } catch { /* ignore */ }
            auth.clear();
            location.hash = "#/tasks";
            setLogged(false);
          }}
        >退出</button>
      </div>
    </nav>
  );

  const content = (() => {
    if (route.startsWith("#/experts")) return <Experts />;
    if (route.startsWith("#/knowledge")) return <Knowledge />;
    if (route.startsWith("#/task/")) {
      const id = route.slice("#/task/".length);
      return <TaskDetail key={id} taskId={id} />;
    }
    if (route.startsWith("#/admin")) return <Admin />;
    return <Tasks />;
  })();

  return (
    <ErrorBoundary title="应用运行异常">
      {nav}
      <ErrorBoundary title="页面加载异常，请尝试刷新">
        {content}
      </ErrorBoundary>
    </ErrorBoundary>
  );
}
