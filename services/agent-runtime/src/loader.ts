// ResourceLoader per session: fixed mode system prompt + platform caps
// (MCP servers via pi-mcp-adapter, skills via skillsOverride).
// All ambient discovery stays OFF: user workspaces must not inject
// extensions/skills/context into sessions (read-only ask mode depends on it).
import {
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { loadMcpAdapter, type ServerEntry } from "./mcp.js";
import { PROMPTS, TOOLS as TOOLS_BASE, type Mode } from "./prompts.js";

export interface McpSpec {
  id: string;
  name: string;
  transport: string; // stdio | http | sse
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface SkillSpec {
  name: string;
  description: string;
  path: string; // dir containing SKILL.md
}

export interface Caps {
  mcp: McpSpec[];
  skills: SkillSpec[];
}

function toServerEntry(m: McpSpec): ServerEntry {
  if (m.transport === "stdio") {
    return { command: m.command ?? "", args: m.args ?? [], env: m.env ?? {} };
  }
  // http/sse: no OAuth per platform policy (auth: false disables auto-detect)
  return { url: m.url ?? "", auth: false };
}

export async function loaderFor(mode: Mode, caps: Caps, cwd: string, agentDir: string): Promise<ResourceLoader> {
  const factories = caps.mcp.length
    ? [(await loadMcpAdapter()).createMcpAdapter({
        config: {
          mcpServers: Object.fromEntries(caps.mcp.map((m) => [m.name || m.id, toServerEntry(m)])),
        },
      })]
    : [];
  const skills: Skill[] = caps.skills.map((k) => ({
    name: k.name,
    description: k.description,
    filePath: `${k.path.replace(/\/$/, "")}/SKILL.md`,
    baseDir: k.path,
    sourceInfo: createSyntheticSourceInfo(`${k.path}/SKILL.md`, {
      source: "custom",
      scope: "user",
      baseDir: k.path,
    }),
    disableModelInvocation: false,
  }));

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: PROMPTS[mode],
    extensionFactories: factories,
    skillsOverride: () => ({ skills, diagnostics: [] }),
    // Drop any discovered extensions (agentDir/workspace); keep only the
    // inline MCP adapter so platform caps are the sole extension source.
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter((e) => e.path.startsWith("<inline")),
    }),
  });
  await loader.reload();
  return loader;
}

// Tool name the MCP adapter registers (proxy tool surface).
export const MCP_TOOL_NAMES = ["mcp"];

export function toolsFor(mode: Mode, caps: Caps): string[] {
  return caps.mcp.length ? [...TOOLS_BASE[mode], ...MCP_TOOL_NAMES] : TOOLS_BASE[mode];
}
