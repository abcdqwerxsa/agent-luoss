// Minimal API client with token storage and typed helpers.
export interface User { id: string; username: string; display_name: string; role: string; status?: string; department_id?: string }
export interface Scope { type: string; value: string }
export interface McpServerInfo { id: string; name: string; transport: string; command: string; args: string[]; url: string; enabled: boolean; scopes: Scope[] }
export interface SkillInfo { id: string; name: string; description: string; enabled: boolean; scopes: Scope[] }
export interface ModelOpt { provider_id: string; model_id: string; display_name: string; context_window?: number; reasoning?: boolean; input_cost?: number; output_cost?: number; enabled?: boolean; tier?: string }
export interface TaskInfo {
  id: string; user_id: string; title: string; mode: string; expert_id?: string;
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
    create: (t: { title: string; mode: string; provider: string; model_id: string; first_message: string; expert_id?: string }) =>
      req<{ task: TaskInfo }>("POST", "/api/v1/tasks", t),
    get: (id: string) => req<{ task: TaskInfo; context_tokens?: number; context_window?: number }>("GET", `/api/v1/tasks/${id}`),
    remove: (id: string) => req("DELETE", `/api/v1/tasks/${id}`),
    patch: (id: string, t: { title?: string; archive?: boolean }) => req("PATCH", `/api/v1/tasks/${id}`, t),
    send: (id: string, message: string, streaming_behavior?: string, images?: { data: string; media_type: string }[]) =>
      req("POST", `/api/v1/tasks/${id}/messages`, { message, streaming_behavior, images }),
    steer: (id: string, message: string) => req("POST", `/api/v1/tasks/${id}/steer`, { message }),
    abort: (id: string) => req("POST", `/api/v1/tasks/${id}/abort`),
    history: (id: string) => req<{ messages: { role: string; content: unknown; model?: string; toolCallId?: string; toolName?: string; isError?: boolean }[] }>("GET", `/api/v1/tasks/${id}/messages`),
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
  experts: () => req<{ experts: { id: string; name: string; description: string; skill_ids?: string[]; mcp_ids?: string[] }[] }>("GET", "/api/v1/experts"),
  usageMe: () => req<{ month_used_usd: number; month_limit_usd: number; recent_days: { day: string; total_tokens: number; cost_usd: number }[] }>("GET", "/api/v1/usage/me"),
  taskUsage: (id: string) => req<{ by_model: { provider: string; model_id: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number; cost_usd: number; task_count: number }[]; total_tokens: number; cost_usd: number }>("GET", `/api/v1/tasks/${id}/usage`),

  admin: {
    users: () => req<{ users: User[] }>("GET", "/api/v1/users"),
    createUser: (u: { username: string; password: string; display_name: string; role: string; department_id?: string }) => req("POST", "/api/v1/users", u),
    updateUser: (id: string, u: Partial<{ display_name: string; role: string; status: string; password: string; department_id: string }>) => req("PATCH", `/api/v1/users/${id}`, u),
    deleteUser: (id: string) => req("DELETE", `/api/v1/users/${id}`),
    providers: () => req<{ providers: { id: string; name: string; base_url: string; api_type: string; has_key: boolean; enabled: boolean }[] }>("GET", "/api/v1/admin/providers"),
    putProvider: (p: { id: string; name: string; base_url: string; api_type: string; api_key?: string; enabled: boolean }) => req("PUT", "/api/v1/admin/providers", p),
    putModel: (m: { provider_id: string; model_id: string; display_name: string; context_window?: number; input_cost?: number; output_cost?: number; reasoning?: boolean; enabled: boolean; tier?: string }) => req("PUT", "/api/v1/admin/models", m),
    deleteModel: (provider_id: string, model_id: string) => req("DELETE", `/api/v1/admin/models?provider_id=${encodeURIComponent(provider_id)}&model_id=${encodeURIComponent(model_id)}`),
    allModels: () => req<{ models: ModelOpt[] }>("GET", "/api/v1/admin/models/all"),
    deleteProvider: (id: string) => req("DELETE", `/api/v1/admin/providers?id=${encodeURIComponent(id)}`),
    fetchProviderModels: (id: string) => req<{ model_ids: string[] }>("POST", `/api/v1/admin/providers/fetch-models?id=${encodeURIComponent(id)}`),
    testModel: (provider_id: string, model_id: string) => req<{ ok: boolean; error?: string; latency_ms: number }>("POST", "/api/v1/admin/models/test", { provider_id, model_id }),
    usage: (q = "") => req<{
      rows: { day: string; user_id: string; total_tokens: number; cost_usd: number; task_count: number }[];
      by_model: { provider: string; model_id: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; total_tokens: number; cost_usd: number; task_count: number }[];
      top_users: { user_id: string; total_tokens: number; cost_usd: number; task_count: number }[];
    }>("GET", `/api/v1/admin/usage${q ? (q.startsWith("?") ? q : `?${q}`) : ""}`),
    audit: (q = "") => req<{ logs: { id: number; actor: string; action: string; resource: string; ts: number; ip: string }[]; total: number }>("GET", `/api/v1/admin/audit${q}`),
    setQuota: (user_id: string, monthly_limit_usd: number) => req("PUT", "/api/v1/admin/quota", { user_id, monthly_limit_usd }),
    departments: () => req<{ departments: { id: string; name: string; created_at: number }[] }>("GET", "/api/v1/admin/departments"),
    createDepartment: (d: { id?: string; name: string }) => req("POST", "/api/v1/admin/departments", d),
    updateDepartment: (id: string, name: string) => req("PATCH", `/api/v1/admin/departments/${id}`, { name }),
    deleteDepartment: (id: string) => req("DELETE", `/api/v1/admin/departments/${id}`),
    mcp: () => req<{ servers: McpServerInfo[] }>("GET", "/api/v1/admin/mcp"),
    putMcp: (m: { id: string; name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean; scopes: Scope[] }) => req("PUT", "/api/v1/admin/mcp", m),
    deleteMcp: (id: string) => req("DELETE", `/api/v1/admin/mcp/${id}`),
    skills: () => req<{ skills: SkillInfo[] }>("GET", "/api/v1/admin/skills"),
    putSkill: (s: { id: string; enabled: boolean; scopes: Scope[] }) => req("PUT", "/api/v1/admin/skills", s),
    async uploadSkill(file: File, opts: { id?: string; enabled: boolean; scopes: Scope[] }) {
      const fd = new FormData();
      fd.append("file", file);
      if (opts.id) fd.append("id", opts.id);
      fd.append("enabled", String(opts.enabled));
      fd.append("scopes", JSON.stringify(opts.scopes));
      const res = await fetch("/api/v1/admin/skills/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
        body: fd,
      });
      if (!res.ok) {
        let msg = "upload failed";
        try { msg = (await res.json()).error || msg; } catch { /* keep */ }
        throw new ApiError(res.status, msg);
      }
      return res.json();
    },
    deleteSkill: (id: string) => req("DELETE", `/api/v1/admin/skills/${id}`),
    experts: () => req<{ experts: any[] }>("GET", "/api/v1/admin/experts"),
    putExpert: (e: { id: string; name: string; description: string; enabled: boolean; skill_ids: string[]; mcp_ids: string[]; scopes: Scope[] }) => req("PUT", "/api/v1/admin/experts", e),
    deleteExpert: (id: string) => req("DELETE", `/api/v1/admin/experts/${id}`),
  },
};
