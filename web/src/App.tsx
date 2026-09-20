import React, { useEffect, useState } from "react";
import { api, auth } from "./lib/api";
import { Icon } from "./lib/icons";
import { ThemeToggle } from "./lib/theme";
import { Login } from "./pages/Login";
import { Tasks } from "./pages/Tasks";
import { Experts } from "./pages/Experts";
import { TaskDetail } from "./pages/TaskDetail";
import { Admin } from "./pages/Admin";

// hash router: #/tasks, #/task/<id>, #/admin
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
        <span className="brand-logo"><Icon name="bot" size={16} /></span>
        <span className="brand-name">AgentLuoss</span>
      </a>
      <div className="nav-links">
        <a href="#/tasks" className={`nav-link ${route.startsWith("#/tasks") || route.startsWith("#/task/") ? "active" : ""}`}>任务</a>
        <a href="#/experts" className={`nav-link ${route.startsWith("#/experts") ? "active" : ""}`}>专家</a>
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

  if (route.startsWith("#/experts")) {
    return <>{nav}<Experts /></>;
  }
  if (route.startsWith("#/task/")) {
    const id = route.slice("#/task/".length);
    return <>{nav}<TaskDetail key={id} taskId={id} /></>;
  }
  if (route.startsWith("#/admin")) {
    return <>{nav}<Admin /></>;
  }
  return <>{nav}<Tasks /></>;
}
