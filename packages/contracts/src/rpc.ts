/**
 * The client ⇄ server protocol. The web client talks to the local server over one WebSocket:
 *
 *   client → server  { id, method, params }
 *   server → client  { id, ok: true, result } | { id, ok: false, error } | { event }
 *
 * Every method is declared once here with its params and result schemas. The server validates
 * params with them; the client gets its types from them.
 */
import { z } from "zod";

import {
  Account,
  Address,
  Activity,
  AgentAccess,
  Draft,
  DraftInput,
  Group,
  Label,
  Mailbox,
  McpInfo,
  Message,
  Provider,
  ServerEndpoint,
  Settings,
  ThreadMark,
  ThreadSummary,
  ThreadTimer,
} from "./domain.ts";

// ── Changes applied to conversations ────────────────────────────────────────────────────────

export const ModifyAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("markRead") }),
  z.object({ type: z.literal("markUnread") }),
  z.object({ type: z.literal("star") }),
  z.object({ type: z.literal("unstar") }),
  /** Out of the inbox; still in All mail and its labels. */
  z.object({ type: z.literal("archive") }),
  /** Back into the inbox (also undoes archive). */
  z.object({ type: z.literal("moveToInbox") }),
  /** Deleted, but kept: out of the inbox, labelled Deleted (Fancy Mail's Trash). Never lost. */
  z.object({ type: z.literal("trash") }),
  /** Out of the trash, back where it was. */
  z.object({ type: z.literal("restore") }),
  /** Delete for good: into the server's own trash (Gmail empties its Bin after 30 days). */
  z.object({ type: z.literal("deleteForGood") }),
  z.object({ type: z.literal("markSpam") }),
  z.object({ type: z.literal("notSpam") }),
  /** Done with it: the Settled label on every message, and read. Stays where it is. */
  z.object({ type: z.literal("settle") }),
  z.object({ type: z.literal("unsettle") }),
  /** Waiting for an answer until then (ms); back with "No reply" after. */
  z.object({ type: z.literal("wait"), until: z.number() }),
  z.object({ type: z.literal("unwait") }),
  /** Out of the way until then (ms). */
  z.object({ type: z.literal("snooze"), until: z.number() }),
  z.object({ type: z.literal("unsnooze") }),
  z.object({ type: z.literal("pin") }),
  z.object({ type: z.literal("unpin") }),
  z.object({ type: z.literal("addLabels"), labelIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("removeLabels"), labelIds: z.array(z.string()).min(1) }),
]);
export type ModifyAction = z.infer<typeof ModifyAction>;

// ── Bootstrap ───────────────────────────────────────────────────────────────────────────────

export const Bootstrap = z.object({
  version: z.string(),
  dataDir: z.string(),
  accounts: z.array(Account),
  groups: z.array(Group),
  labels: z.array(Label),
  mailboxes: z.array(Mailbox),
  settings: Settings,
  mcp: McpInfo,
  /** Demo accounts are present (shown until the user removes them). */
  hasDemoData: z.boolean(),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

export const SearchResult = z.object({
  threads: z.array(ThreadSummary),
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
  /** Conversations matching in all pages (exact up to 10,000). */
  total: z.number().int(),
  /** Pieces of the query that were not understood and left out. */
  queryErrors: z.array(z.string()),
});
export type SearchResult = z.infer<typeof SearchResult>;

/** Where a search's matches are: conversations per account and per label (the sidebar's counts). */
export const SearchFacets = z.object({
  total: z.number().int(),
  byAccount: z.record(z.string(), z.number().int()),
  byLabel: z.record(z.string(), z.number().int()),
  queryErrors: z.array(z.string()),
});
export type SearchFacets = z.infer<typeof SearchFacets>;

export const ThreadDetail = z.object({
  thread: ThreadSummary,
  messages: z.array(Message),
  /** Unsent drafts in this conversation (a reply an agent prepared shows here for review). */
  drafts: z.array(Draft),
});
export type ThreadDetail = z.infer<typeof ThreadDetail>;

export const ProviderDetection = z.object({
  provider: Provider,
  presetId: z.string().nullable(),
  name: z.string(),
  imap: ServerEndpoint.nullable(),
  smtp: ServerEndpoint.nullable(),
  auth: z.array(z.enum(["password", "oauth-google", "oauth-microsoft"])),
  appPasswordUrl: z.string().nullable(),
  passwordHint: z.string().nullable(),
});
export type ProviderDetection = z.infer<typeof ProviderDetection>;

const Empty = z.object({});

// ── Methods ─────────────────────────────────────────────────────────────────────────────────

export const RPC_METHODS = {
  "app.bootstrap": { params: Empty, result: Bootstrap },

  /** To / Cc / Bcc suggestions: people in your mail whose name or address matches. */
  "contacts.suggest": {
    params: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
    result: z.array(Address),
  },
  "threads.search": {
    params: z.object({
      query: z.string(),
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    result: SearchResult,
  },
  "threads.facets": {
    params: z.object({ query: z.string() }),
    result: SearchFacets,
  },
  /** Waiting and snoozed conversations' times, and why some came back (shown on their rows). */
  "threads.states": {
    params: Empty,
    result: z.object({ timers: z.array(ThreadTimer), marks: z.array(ThreadMark) }),
  },
  /** Seen: the conversation's "Replied" / "No reply" / "Woke" goes away. */
  "threads.clearMark": { params: z.object({ threadId: z.string() }), result: Empty },
  "threads.get": {
    params: z.object({ threadId: z.string() }),
    result: ThreadDetail,
  },
  "threads.modify": {
    params: z.object({
      threadIds: z.array(z.string()).min(1),
      actions: z.array(ModifyAction).min(1),
    }),
    result: z.object({ activity: Activity.nullable() }),
  },
  /** Download the bodies of a thread now (opening a thread does this by itself). */
  "threads.fetchBodies": {
    params: z.object({ threadId: z.string() }),
    result: Empty,
  },

  "labels.create": {
    params: z.object({ name: z.string().min(1), color: z.string().nullable().optional() }),
    result: Label,
  },
  "labels.update": {
    params: z.object({
      labelId: z.string(),
      name: z.string().min(1).optional(),
      color: z.string().nullable().optional(),
    }),
    result: Label,
  },
  /** Removes the label from every conversation, then deletes it. */
  "labels.delete": { params: z.object({ labelId: z.string() }), result: Empty },
  "labels.reorder": { params: z.object({ labelIds: z.array(z.string()) }), result: Empty },

  "groups.create": {
    params: z.object({ name: z.string().min(1), color: z.string().optional() }),
    result: Group,
  },
  "groups.update": {
    params: z.object({
      groupId: z.string(),
      name: z.string().min(1).optional(),
      color: z.string().optional(),
      collapsed: z.boolean().optional(),
    }),
    result: Group,
  },
  /** The group's accounts stay; they become ungrouped. */
  "groups.delete": { params: z.object({ groupId: z.string() }), result: Empty },
  "groups.reorder": { params: z.object({ groupIds: z.array(z.string()) }), result: Empty },

  "accounts.detect": {
    params: z.object({ email: z.string() }),
    result: ProviderDetection,
  },
  /** Checks the IMAP and SMTP sign-in first; nothing is saved when it fails. */
  "accounts.addWithPassword": {
    params: z.object({
      email: z.string().email(),
      displayName: z.string(),
      password: z.string().min(1),
      provider: Provider,
      imap: ServerEndpoint,
      smtp: ServerEndpoint,
      /** Defaults to the email address. */
      username: z.string().optional(),
      groupId: z.string().nullable().optional(),
    }),
    result: Account,
  },
  /**
   * Opens the provider's sign-in page in the browser (the client opens `authUrl`). The result
   * comes back as an `oauthFinished` event with the same `flowId`.
   */
  "accounts.startOAuth": {
    params: z.object({
      provider: z.enum(["google", "microsoft"]),
      /** Sign this existing account back in instead of adding a new one. */
      accountId: z.string().optional(),
      groupId: z.string().nullable().optional(),
    }),
    result: z.object({ flowId: z.string(), authUrl: z.string() }),
  },
  "accounts.cancelOAuth": { params: z.object({ flowId: z.string() }), result: Empty },
  /** New password for an account whose sign-in stopped working. */
  "accounts.reconnect": {
    params: z.object({ accountId: z.string(), password: z.string().min(1) }),
    result: Account,
  },
  "accounts.update": {
    params: z.object({
      accountId: z.string(),
      displayName: z.string().optional(),
      /** Empty: mail goes out with the address alone. */
      senderName: z.string().optional(),
      color: z.string().optional(),
      groupId: z.string().nullable().optional(),
      agentAccess: AgentAccess.optional(),
      signature: z.string().optional(),
      paused: z.boolean().optional(),
    }),
    result: Account,
  },
  /** Order inside a group (or among ungrouped accounts), and optionally a move to `groupId`. */
  "accounts.reorder": {
    params: z.object({
      accountIds: z.array(z.string()),
      groupId: z.string().nullable().optional(),
    }),
    result: Empty,
  },
  /** Forgets the account, its credentials and its local mail. Nothing changes on the server. */
  "accounts.remove": { params: z.object({ accountId: z.string() }), result: Empty },
  "accounts.syncNow": {
    params: z.object({ accountId: z.string().optional() }),
    result: Empty,
  },

  "drafts.get": { params: z.object({ draftId: z.string() }), result: Draft },
  "drafts.list": { params: Empty, result: z.array(Draft) },
  "drafts.save": { params: z.object({ draft: DraftInput }), result: Draft },
  "drafts.delete": { params: z.object({ draftId: z.string() }), result: Empty },
  /** Queues the draft; a `draftSent` event says how it went. */
  /** `undoable`: wait the Undo send time first (Settings); agents always send at once. */
  /** waitUntil: once sent, the conversation waits for an answer until then. */
  "drafts.send": {
    params: z.object({ draftId: z.string(), undoable: z.boolean().optional(), waitUntil: z.number().nullable().optional() }),
    result: Draft,
  },
  /** Stops a send that is still waiting; the message is a draft again. Fails once it went out. */
  "drafts.cancelSend": { params: z.object({ draftId: z.string() }), result: Draft },
  /** Sends a waiting message now instead of at the end of its wait. */
  "drafts.sendNow": { params: z.object({ draftId: z.string() }), result: Empty },

  "activity.list": {
    params: z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    result: z.object({ items: z.array(Activity), nextCursor: z.string().nullable() }),
  },
  "activity.undo": { params: z.object({ activityId: z.string() }), result: Activity },

  "settings.update": {
    params: z.object({ patch: Settings.partial() }),
    result: Settings,
  },

  "mcp.info": { params: Empty, result: McpInfo },
  "mcp.rotateToken": { params: Empty, result: McpInfo },

  /** Deletes the demo accounts and everything in them. */
  "demo.remove": { params: Empty, result: Empty },
  /** Puts the demo accounts back as they were first seeded. */
  "demo.reset": { params: Empty, result: Empty },
} as const;

export type RpcMethods = typeof RPC_METHODS;
export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = z.input<RpcMethods[M]["params"]>;
export type RpcResult<M extends RpcMethod> = z.infer<RpcMethods[M]["result"]>;

export const RPC_ERROR_CODES = [
  "bad_request",
  "not_found",
  "forbidden",
  "auth_failed",
  "connection_failed",
  "conflict",
  "internal",
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export interface RpcError {
  code: RpcErrorCode;
  /** A sentence for the user: what went wrong and what to do. */
  message: string;
}

export interface RpcRequest {
  id: number;
  method: string;
  params: unknown;
}

export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: RpcError };
