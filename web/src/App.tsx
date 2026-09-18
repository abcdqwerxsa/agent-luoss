import React, { useEffect, useState } from "react";
import { api, auth } from "./lib/api";
import { Login } from "./pages/Login";
import { Tasks } from "./pages/Tasks";
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
      <a href="#/tasks" className={route.startsWith("#/task") ? "active" : ""}>任务</a>
      {user?.role === "admin" && <a href="#/admin" className={route.startsWith("#/admin") ? "active" : ""}>管理</a>}
      <span className="spacer" />
      <span className="who">{user?.display_name || user?.username} · {user?.role}</span>
      <button
        className="btn ghost"
        onClick={async () => {
          try { await api.logout(); } catch { /* ignore */ }
          auth.clear();
          location.hash = "#/tasks";
          setLogged(false);
        }}
      >退出</button>
    </nav>
  );

  if (route.startsWith("#/task/")) {
    const id = route.slice("#/task/".length);
    return <>{nav}<TaskDetail key={id} taskId={id} /></>;
  }
  if (route.startsWith("#/admin")) {
    return <>{nav}<Admin /></>;
  }
  return <>{nav}<Tasks /></>;
}
