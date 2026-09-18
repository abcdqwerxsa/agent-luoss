// Minimal API client with token storage and typed helpers.
export interface User { id: string; username: string; display_name: string; role: string; status?: string }
export interface ModelOpt { provider_id: string; model_id: string; display_name: string; context_window?: number; reasoning?: boolean }
export interface TaskInfo {
  id: string; user_id: string; title: string; mode: string;
  provider: string; model_id: string; status: string;
  first_message?: string; created_at: number; updated_at: number;
}

const TOKEN_KEY = "al_token";
const REFRESH_KEY = "al_refresh";
const USER_KEY = "al_user";

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY) || ""; },
  get refreshToken() { return localStorage.getItem(REFRESH_KEY) || ""; },
  get user(): User | null {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; }
  },
  save(tok: string, refresh: string, user: User) {
    localStorage.setItem(TOKEN_KEY, tok);
    localStorage.setItem(REFRESH_KEY, refresh);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* keep */ }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  tokenSafe: () => auth.token,
  login: (username: string, password: string) =>
    req<{ access_token: string; refresh_token: string; user: User }>("POST", "/api/v1/auth/login", { username, password }),
  logout: () => req("POST", "/api/v1/auth/logout", { refresh_token: auth.refreshToken }),

  tasks: {
    list: (q = "") => req<{ tasks: TaskInfo[]; total: number }>("GET", `/api/v1/tasks${q}`),
    create: (t: { title: string; mode: string; provider: string; model_id: string; first_message: string }) =>
      req<{ task: TaskInfo }>("POST", "/api/v1/tasks", t),
    get: (id: string) => req<{ task: TaskInfo }>("GET", `/api/v1/tasks/${id}`),
    remove: (id: string) => req("DELETE", `/api/v1/tasks/${id}`),
    patch: (id: string, t: { title?: string; archive?: boolean }) => req("PATCH", `/api/v1/tasks/${id}`, t),
    send: (id: string, message: string, streaming_behavior?: string, images?: { data: string; media_type: string }[]) =>
      req("POST", `/api/v1/tasks/${id}/messages`, { message, streaming_behavior, images }),
    steer: (id: string, message: string) => req("POST", `/api/v1/tasks/${id}/steer`, { message }),
    abort: (id: string) => req("POST", `/api/v1/tasks/${id}/abort`),
    history: (id: string) => req<{ messages: { role: string; content: unknown; model?: string }[] }>("GET", `/api/v1/tasks/${id}/messages`),
  },

  files: {
    list: (path: string) => req<{ path: string; nodes: { name: string; is_dir: boolean; size: number; modified_at: number }[] }>("GET", `/api/v1/files?path=${encodeURIComponent(path)}`),
    remove: (path: string) => req("DELETE", `/api/v1/files?path=${encodeURIComponent(path)}`),
    async download(path: string): Promise<Blob> {
      const res = await fetch(`/api/v1/files/download?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!res.ok) throw new ApiError(res.status, "download failed");
      return res.blob();
    },
    async upload(path: string, file: File) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("path", path);
      const res = await fetch("/api/v1/files/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
        body: fd,
      });
      if (!res.ok) throw new ApiError(res.status, "upload failed");
      return res.json();
    },
  },

  models: () => req<{ models: ModelOpt[] }>("GET", "/api/v1/models"),
  usageMe: () => req<{ month_used_usd: number; month_limit_usd: number; recent_days: { day: string; total_tokens: number; cost_usd: number }[] }>("GET", "/api/v1/usage/me"),

  admin: {
    users: () => req<{ users: User[] }>("GET", "/api/v1/users"),
    createUser: (u: { username: string; password: string; display_name: string; role: string }) => req("POST", "/api/v1/users", u),
    updateUser: (id: string, u: Partial<{ display_name: string; role: string; status: string; password: string }>) => req("PATCH", `/api/v1/users/${id}`, u),
    deleteUser: (id: string) => req("DELETE", `/api/v1/users/${id}`),
    providers: () => req<{ providers: { id: string; name: string; base_url: string; api_type: string; has_key: boolean; enabled: boolean }[] }>("GET", "/api/v1/admin/providers"),
    putProvider: (p: { id: string; name: string; base_url: string; api_type: string; api_key?: string; enabled: boolean }) => req("PUT", "/api/v1/admin/providers", p),
    putModel: (m: { provider_id: string; model_id: string; display_name: string; context_window?: number; input_cost?: number; output_cost?: number; enabled: boolean }) => req("PUT", "/api/v1/admin/models", m),
    usage: (user_id?: string) => req<{ rows: { day: string; user_id: string; total_tokens: number; cost_usd: number; task_count: number }[] }>("GET", `/api/v1/admin/usage${user_id ? `?user_id=${user_id}` : ""}`),
    audit: (q = "") => req<{ logs: { id: number; actor: string; action: string; resource: string; ts: number; ip: string }[]; total: number }>("GET", `/api/v1/admin/audit${q}`),
    setQuota: (user_id: string, monthly_limit_usd: number) => req("PUT", "/api/v1/admin/quota", { user_id, monthly_limit_usd }),
  },
};
