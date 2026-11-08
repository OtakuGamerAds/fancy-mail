import type { Actor } from "@fancy-mail/contracts";

const KNOWN_AGENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  claudecode: "Claude Code",
  claude: "Claude",
  "claude-ai": "Claude",
  "claude-desktop": "Claude Desktop",
  t3code: "T3 Code",
  "t3-code": "T3 Code",
  codex: "Codex",
  "codex-mcp-client": "Codex",
  cursor: "Cursor",
  "cursor-vscode": "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
  zed: "Zed",
};

/** What an MCP client called itself, made readable: "claude-code" → "Claude Code". */
export function prettifyAgentName(name: string): string {
  const key = name.trim().toLowerCase();
  if (KNOWN_AGENTS[key]) return KNOWN_AGENTS[key];
  const words = key.split(/[-_\s.]+/).filter(Boolean);
  if (words.length === 0) return "An agent";
  return words.map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

export function actorLabel(actor: Actor): string {
  if (actor.kind === "user") return "You";
  if (actor.kind === "sync") return "Sync";
  return prettifyAgentName(actor.name);
}
