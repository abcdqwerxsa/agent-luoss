// Runtime loader for pi-mcp-adapter via jiti. The package ships TypeScript
// source meant for pi's source-loader; importing it statically would drag
// its sources into tsc's program (implicit-any noise under strict mode).
// jiti transpiles on demand — same mechanism pi itself uses for extensions.
import { createJiti } from "jiti";

export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
}

export interface McpAdapterFactory {
  (pi: unknown): void;
}

interface McpAdapterModule {
  createMcpAdapter(options: {
    config: { mcpServers?: Record<string, ServerEntry> };
  }): McpAdapterFactory;
}

let cached: Promise<McpAdapterModule> | null = null;

export function loadMcpAdapter(): Promise<McpAdapterModule> {
  cached ??= createJiti(import.meta.url).import("pi-mcp-adapter") as Promise<McpAdapterModule>;
  return cached;
}
