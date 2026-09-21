// Session pool: one pi AgentSession per task, idle eviction to bound memory.
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { loaderFor, toolsFor, type Caps } from "./loader.js";
import type { Mode } from "./prompts.js";
import type { EventBus, OutEvent } from "./eventbus.js";

export interface SessionSpec {
  taskId: string;
  userId: string;
  mode: Mode;
  provider: string;
  modelId: string;
  workspacePath: string;
  sessionPath: string; // "" = new
  caps: Caps;
}

export class SessionPool {
  private sessions = new Map<string, { s: AgentSession; lastActive: number; unsub: () => void; spec: SessionSpec }>();
  modelRuntime: ModelRuntime | null = null;

  constructor(
    private opts: {
      modelsPath: string;
      authPath: string;
      sessionsDir: string;
      agentDir: string;
      maxSessions: number;
      idleTtlMs: number;
      bus: EventBus;
    },
  ) {}

  async initModelRuntime(): Promise<void> {
    const rt = await ModelRuntime.create({
      authPath: this.opts.authPath,
      modelsPath: this.opts.modelsPath,
    });
    // Inline apiKey entries in models.json are not reliably resolved after a
    // reload; register them as runtime overrides explicitly (never persisted).
    try {
      const cfg = JSON.parse(fs.readFileSync(this.opts.modelsPath, "utf8"));
      for (const [id, p] of Object.entries<any>(cfg.providers ?? {})) {
        if (typeof p?.apiKey === "string" && p.apiKey && !p.apiKey.startsWith("$")) {
          await rt.setRuntimeApiKey(id, p.apiKey);
        }
      }
    } catch {
      /* config file optional at boot */
    }
    this.modelRuntime = rt;
  }

  count(): number {
    return this.sessions.size;
  }

  max(): number {
    return this.opts.maxSessions;
  }

  has(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  get(taskId: string): AgentSession | undefined {
    const e = this.sessions.get(taskId);
    if (e) e.lastActive = Date.now();
    return e?.s;
  }

  modeOf(taskId: string): string | undefined {
    return this.sessions.get(taskId)?.spec.mode;
  }

  // switchMode rebuilds the session with a new permission mode, reusing the
  // same session file (conversation history preserved) — the same path the
  // task service uses to recover sessions after eviction. New toolset,
  // system prompt, and caps loader are rebuilt for the target mode.
  async switchMode(taskId: string, mode: Mode): Promise<AgentSession> {
    const e = this.sessions.get(taskId);
    if (!e) throw new Error("session not in pool");
    if (e.s.isStreaming) throw new Error("cannot switch mode while streaming");
    e.unsub();
    this.sessions.delete(taskId);
    await this.create({ ...e.spec, mode, sessionPath: e.s.sessionFile ?? "" });
    const s = this.sessions.get(taskId)?.s;
    if (!s) throw new Error("mode switch failed");
    return s;
  }

  async create(spec: SessionSpec): Promise<{ sessionId: string; sessionPath: string; resumed: boolean }> {
    if (this.sessions.has(spec.taskId)) {
      throw new Error(`session exists: ${spec.taskId}`);
    }
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new Error(`runtime at capacity (${this.opts.maxSessions})`);
    }
    if (!this.modelRuntime) throw new Error("model runtime not initialized");

    fs.mkdirSync(spec.workspacePath, { recursive: true });
    fs.mkdirSync(this.opts.sessionsDir, { recursive: true });
    fs.mkdirSync(this.opts.agentDir, { recursive: true });

    const model = this.modelRuntime.getModel(spec.provider, spec.modelId);
    if (!model) throw new Error(`model not found: ${spec.provider}/${spec.modelId}`);

    const sessionManager = spec.sessionPath
      ? SessionManager.open(spec.sessionPath, this.opts.sessionsDir, spec.workspacePath)
      : SessionManager.create(spec.workspacePath, this.opts.sessionsDir);

    const { session } = await createAgentSession({
      cwd: spec.workspacePath,
      agentDir: this.opts.agentDir,
      model,
      modelRuntime: this.modelRuntime,
      resourceLoader: await loaderFor(spec.mode, spec.caps, spec.workspacePath, this.opts.agentDir),
      tools: toolsFor(spec.mode, spec.caps),
      sessionManager,
    });

    const unsub = session.subscribe((event: any) => {
      const out: OutEvent = {
        taskId: spec.taskId,
        sessionId: session.sessionId,
        type: event.type,
        payload: safeJson(event),
        timestamp: Date.now(),
      };
      this.opts.bus.push(out);
      // Context usage follow-up: pushes the live context occupancy so the
      // UI can show a meter; safe no-op when usage is not yet estimated.
      if (event.type === "message_end" || event.type === "agent_settled") {
        try {
          const cu = (session as any).getContextUsage?.();
          if (cu && (cu.tokens != null || cu.contextWindow)) {
            this.opts.bus.push({
              taskId: spec.taskId,
              sessionId: session.sessionId,
              type: "context_usage",
              payload: JSON.stringify({ tokens: cu.tokens, contextWindow: cu.contextWindow, percent: cu.percent ?? null }),
              timestamp: Date.now(),
            });
          }
        } catch { /* context usage is best-effort */ }
      }
    });

    this.sessions.set(spec.taskId, { s: session, lastActive: Date.now(), unsub, spec });
    return {
      sessionId: session.sessionId,
      sessionPath: session.sessionFile ?? path.join(this.opts.sessionsDir, `${session.sessionId}.jsonl`),
      resumed: Boolean(spec.sessionPath),
    };
  }

  close(taskId: string): boolean {
    const e = this.sessions.get(taskId);
    if (!e) return false;
    e.unsub();
    e.s.dispose();
    this.sessions.delete(taskId);
    return true;
  }

  // Sweep evicts idle sessions; task-svc re-creates them on next prompt
  // (CreateSession with the stored session_path resumes from file).
  startSweep(intervalMs: number): void {
    setInterval(() => {
      const now = Date.now();
      for (const [taskId, e] of this.sessions) {
        if (!e.s.isStreaming && now - e.lastActive > this.opts.idleTtlMs) {
          console.log(`[pool] evicting idle session ${taskId}`);
          this.close(taskId);
        }
      }
    }, intervalMs);
  }

  disposeAll(): void {
    for (const taskId of this.sessions.keys()) this.close(taskId);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "{}";
  }
}
