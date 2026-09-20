// Theme switch: dark (default) <-> light, persisted in localStorage.
// index.html applies the stored theme before React mounts (no flash).
import React, { useState } from "react";
import { Icon } from "./icons";

export type Theme = "dark" | "light";

const KEY = "al_theme";

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem(KEY, t);
}

export function toggleTheme(): Theme {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

// Theme toggle button used in topnav and login.
export function ThemeToggle() {
  const [theme, setThemeState] = useState(getTheme());
  return (
    <button
      className="icon-btn"
      title={theme === "dark" ? "切换亮色模式" : "切换暗色模式"}
      onClick={() => setThemeState(toggleTheme())}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
    </button>
  );
}
