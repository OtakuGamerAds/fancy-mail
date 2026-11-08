/**
 * What the server pushes to every connected client. Clients keep no state of their own beyond
 * caches: an `invalidate` tells them which caches to refetch.
 */
import type { AccountStatus, Activity, McpClient } from "./domain.ts";

export const INVALIDATION_TOPICS = [
  "accounts",
  "groups",
  "labels",
  "mailboxes",
  "threads",
  "drafts",
  "activity",
  "settings",
  "mcp",
] as const;
export type InvalidationTopic = (typeof INVALIDATION_TOPICS)[number];

export type ServerEvent =
  /**
   * Something changed. With `threadIds`, only those conversations (and any list that may hold
   * them) changed; without, refetch everything under the topics.
   */
  | { type: "invalidate"; topics: InvalidationTopic[]; threadIds?: string[] }
  | { type: "accountStatus"; accountId: string; status: AccountStatus }
  /** A change was made by the user or an agent; agent changes show a toast with Undo. */
  | { type: "activity"; activity: Activity }
  | { type: "oauthFinished"; flowId: string; ok: boolean; accountId: string | null; error: string | null }
  | { type: "mcpClients"; clients: McpClient[] }
  | { type: "draftSent"; draftId: string; ok: boolean; error: string | null }
  /** New mail arrived in an inbox (for the badge and a quiet notification). */
  | { type: "newMail"; accountId: string; threadIds: string[]; count: number };

export type ServerMessage = { event: ServerEvent };
