/**
 * Who is calling, and what agents may do. Services call these guards; transports only build
 * the context.
 */
import { AGENT_ACCESS_INFO, agentAccessAllows } from "@fancy-mail/contracts";
import type { Actor, AgentAccess } from "@fancy-mail/contracts";

import { AppError } from "../errors.ts";
import type { AccountRecord } from "../store/types.ts";

export interface CallContext {
  actor: Actor;
}

export const USER: CallContext = { actor: { kind: "user" } };
export const SYNC: CallContext = { actor: { kind: "sync" } };

export function isAgent(ctx: CallContext): ctx is CallContext & { actor: { kind: "agent"; name: string } } {
  return ctx.actor.kind === "agent";
}

/** "Claude Code" for "claude-code": how an agent is named in messages. */
export function agentDisplayName(name: string): string {
  const known: Record<string, string> = {
    "claude-code": "Claude Code",
    claude: "Claude",
    "claude-ai": "Claude",
    t3code: "T3 Code",
    "t3-code": "T3 Code",
    codex: "Codex",
    cursor: "Cursor",
  };
  const key = name.trim().toLowerCase();
  if (known[key]) return known[key];
  return name.trim() || "An agent";
}

/** Account ids an agent can see (access other than "none"); null for the user and sync. */
export function visibleAccountIds(ctx: CallContext, accounts: AccountRecord[]): string[] | null {
  if (!isAgent(ctx)) return null;
  return accounts.filter((a) => a.agentAccess !== "none").map((a) => a.id);
}

export function canSee(ctx: CallContext, account: AccountRecord): boolean {
  return !isAgent(ctx) || account.agentAccess !== "none";
}

/** Throws `forbidden` naming the account and its level when an agent lacks `needed`. */
export function requireAccess(ctx: CallContext, account: AccountRecord, needed: AgentAccess, what: string): void {
  if (!isAgent(ctx)) return;
  if (agentAccessAllows(account.agentAccess, needed)) return;
  const level = AGENT_ACCESS_INFO[account.agentAccess].label;
  const neededLabel = AGENT_ACCESS_INFO[needed].label;
  throw new AppError(
    "forbidden",
    `${account.email} allows agents "${level}" access, and ${what} needs "${neededLabel}". The user can change this in Fancy Mail › Settings › Accounts.`,
  );
}

/** For things only the person at the computer may do (settings, adding accounts, …). */
export function requireUser(ctx: CallContext, what: string): void {
  if (isAgent(ctx)) {
    throw new AppError("forbidden", `Only the user can ${what}, in the Fancy Mail app.`);
  }
}

/** Agents need `needed` on at least one account (label and group changes are global). */
export function requireAnyAccess(ctx: CallContext, accounts: AccountRecord[], needed: AgentAccess, what: string): void {
  if (!isAgent(ctx)) return;
  if (accounts.some((a) => agentAccessAllows(a.agentAccess, needed))) return;
  throw new AppError(
    "forbidden",
    `${what} needs "${AGENT_ACCESS_INFO[needed].label}" access on at least one account. The user can allow it in Fancy Mail › Settings › Accounts.`,
  );
}
