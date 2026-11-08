/**
 * The mail domain, shared by the server, the web client, the desktop shell and the MCP tools.
 * Everything that crosses a process boundary is described here once.
 */
import { z } from "zod";

// ── Agent access ────────────────────────────────────────────────────────────────────────────
//
// How much an AI agent (connected over MCP) may do with one account. Levels are ordered: each
// one includes everything before it. "none" hides the account from agents entirely.

export const AGENT_ACCESS_LEVELS = ["none", "read", "organize", "draft", "send"] as const;
export const AgentAccess = z.enum(AGENT_ACCESS_LEVELS);
export type AgentAccess = z.infer<typeof AgentAccess>;

export function agentAccessAllows(level: AgentAccess, needed: AgentAccess): boolean {
  return AGENT_ACCESS_LEVELS.indexOf(level) >= AGENT_ACCESS_LEVELS.indexOf(needed);
}

export const AGENT_ACCESS_INFO: Record<AgentAccess, { label: string; description: string }> = {
  none: { label: "Hidden", description: "Agents can't see this account at all." },
  read: { label: "Read", description: "Search and read mail and attachments." },
  organize: { label: "Organize", description: "Read, plus labels, archive, read state, stars and trash." },
  draft: { label: "Draft", description: "Organize, plus write drafts for you to review and send." },
  send: { label: "Send", description: "Draft, plus send mail on your behalf." },
};

// ── Accounts ────────────────────────────────────────────────────────────────────────────────

export const Provider = z.enum(["gmail", "outlook", "imap", "demo"]);
export type Provider = z.infer<typeof Provider>;

export const AuthKind = z.enum(["password", "oauth-google", "oauth-microsoft", "none"]);
export type AuthKind = z.infer<typeof AuthKind>;

export const ServerEndpoint = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** true: TLS from the first byte (993, 465). false: STARTTLS (143, 587). */
  secure: z.boolean(),
});
export type ServerEndpoint = z.infer<typeof ServerEndpoint>;

export const AccountSyncState = z.enum([
  /** Not connected yet, nothing wrong. */
  "idle",
  "connecting",
  "syncing",
  /** Connected and up to date; listening for new mail. */
  "ready",
  /** The network or the server failed; retrying by itself. Credentials are kept. */
  "offline",
  /** The server refused the credentials. Kept as they are until the user reconnects. */
  "auth-required",
  "error",
  /** Demo accounts, and accounts the user paused. */
  "paused",
]);
export type AccountSyncState = z.infer<typeof AccountSyncState>;

export const AccountStatus = z.object({
  state: AccountSyncState,
  message: z.string().nullable(),
  lastSyncAt: z.number().nullable(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable(),
});
export type AccountStatus = z.infer<typeof AccountStatus>;

export const Account = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  provider: Provider,
  authKind: AuthKind,
  groupId: z.string().nullable(),
  color: z.string(),
  sortOrder: z.number(),
  agentAccess: AgentAccess,
  signature: z.string(),
  imap: ServerEndpoint.nullable(),
  smtp: ServerEndpoint.nullable(),
  status: AccountStatus,
  unreadInboxCount: z.number().int(),
  createdAt: z.number(),
});
export type Account = z.infer<typeof Account>;

export const Group = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  sortOrder: z.number(),
  collapsed: z.boolean(),
  unreadInboxCount: z.number().int(),
});
export type Group = z.infer<typeof Group>;

/**
 * A label is global: "Invoices" is one label across every account. On Gmail accounts it is
 * mirrored to a real Gmail label of the same name, on other IMAP servers to a keyword, so the
 * organization survives even if this app is gone.
 */
export const Label = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  sortOrder: z.number(),
  threadCount: z.number().int(),
  unreadThreadCount: z.number().int(),
});
export type Label = z.infer<typeof Label>;

export const MailboxRole = z.enum([
  "inbox",
  "sent",
  "drafts",
  "trash",
  "spam",
  "archive",
  "all",
  "important",
  "starred",
]);
export type MailboxRole = z.infer<typeof MailboxRole>;

/** A folder on the server (IMAP mailbox, or a Gmail system label). */
export const Mailbox = z.object({
  id: z.string(),
  accountId: z.string(),
  path: z.string(),
  name: z.string(),
  role: MailboxRole.nullable(),
  unreadCount: z.number().int(),
  totalCount: z.number().int(),
});
export type Mailbox = z.infer<typeof Mailbox>;

// ── Messages and threads ────────────────────────────────────────────────────────────────────

export const Address = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type Address = z.infer<typeof Address>;

export const ThreadSummary = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string(),
  snippet: z.string(),
  /** Distinct senders, oldest first (the way Gmail names a conversation). */
  participants: z.array(Address),
  lastMessageAt: z.number(),
  messageCount: z.number().int(),
  unreadCount: z.number().int(),
  starred: z.boolean(),
  hasAttachments: z.boolean(),
  labelIds: z.array(z.string()),
  inInbox: z.boolean(),
  inSent: z.boolean(),
  inTrash: z.boolean(),
  inSpam: z.boolean(),
  draftCount: z.number().int(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const AttachmentMeta = z.object({
  id: z.string(),
  messageId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  contentId: z.string().nullable(),
  /** Shown inside the body (cid: image), not in the attachment list. */
  inline: z.boolean(),
  /** The file is on this computer already. */
  downloaded: z.boolean(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

export const MessageBody = z.object({
  text: z.string().nullable(),
  html: z.string().nullable(),
});
export type MessageBody = z.infer<typeof MessageBody>;

export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  accountId: z.string(),
  messageIdHeader: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  from: Address.nullable(),
  to: z.array(Address),
  cc: z.array(Address),
  bcc: z.array(Address),
  replyTo: z.array(Address),
  subject: z.string(),
  date: z.number(),
  snippet: z.string(),
  unread: z.boolean(),
  starred: z.boolean(),
  isDraft: z.boolean(),
  labelIds: z.array(z.string()),
  attachments: z.array(AttachmentMeta),
  /** null while the body has not been downloaded yet (a `threads` invalidation follows). */
  body: MessageBody.nullable(),
});
export type Message = z.infer<typeof Message>;

// ── Who did something ───────────────────────────────────────────────────────────────────────

export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  /** An MCP client; `name` is what it called itself ("claude-code", "t3code"...). */
  z.object({ kind: z.literal("agent"), name: z.string() }),
  /** The sync engine, applying what changed on the server. */
  z.object({ kind: z.literal("sync") }),
]);
export type Actor = z.infer<typeof Actor>;

// ── Drafts ──────────────────────────────────────────────────────────────────────────────────

export const DraftMode = z.enum(["new", "reply", "replyAll", "forward"]);
export type DraftMode = z.infer<typeof DraftMode>;

export const DraftAttachment = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
});
export type DraftAttachment = z.infer<typeof DraftAttachment>;

export const DraftSendState = z.enum(["draft", "queued", "sending", "failed", "sent"]);
export type DraftSendState = z.infer<typeof DraftSendState>;

export const Draft = z.object({
  id: z.string(),
  accountId: z.string(),
  mode: DraftMode,
  /** The conversation it answers or forwards; null for a new message. */
  threadId: z.string().nullable(),
  /** The conversation it shows up as in lists: `threadId`, or a new message's own. */
  conversationId: z.string(),
  /** The message it answers or forwards. */
  sourceMessageId: z.string().nullable(),
  to: z.array(Address),
  cc: z.array(Address),
  bcc: z.array(Address),
  subject: z.string(),
  bodyText: z.string(),
  attachments: z.array(DraftAttachment),
  createdBy: Actor,
  updatedAt: z.number(),
  sendState: DraftSendState,
  sendError: z.string().nullable(),
});
export type Draft = z.infer<typeof Draft>;

export const DraftInput = z.object({
  /** Omit to create a new draft. */
  id: z.string().optional(),
  accountId: z.string(),
  mode: DraftMode,
  threadId: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  to: z.array(Address),
  cc: z.array(Address),
  bcc: z.array(Address),
  subject: z.string(),
  bodyText: z.string(),
  attachments: z.array(DraftAttachment),
});
export type DraftInput = z.infer<typeof DraftInput>;

// ── Activity (what happened, by whom, and the way back) ─────────────────────────────────────

export const Activity = z.object({
  id: z.string(),
  at: z.number(),
  actor: Actor,
  /** One line, in the product's voice: "Archived 12 conversations", "Labeled 3 as Invoices". */
  summary: z.string(),
  kind: z.string(),
  threadIds: z.array(z.string()),
  undoable: z.boolean(),
  undoneAt: z.number().nullable(),
});
export type Activity = z.infer<typeof Activity>;

// ── Settings ────────────────────────────────────────────────────────────────────────────────

export const Settings = z.object({
  readingPane: z.enum(["right", "off"]),
  density: z.enum(["comfortable", "compact"]),
  /** "ask": remote images are blocked until shown for a message or always allowed for a sender. */
  remoteImages: z.enum(["ask", "always"]),
  allowedImageSenders: z.array(z.string()),
  closeToTray: z.boolean(),
  /** What new accounts get. Each account has its own level after that. */
  defaultAgentAccess: AgentAccess,
  mcp: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65535),
  }),
  oauth: z.object({
    googleClientId: z.string(),
    googleClientSecret: z.string(),
    microsoftClientId: z.string(),
  }),
  sync: z.object({
    /** How far back the first sync of a new account reaches. 0: everything. */
    initialDays: z.number().int().min(0),
    /** How many of the newest bodies are downloaded ahead of time per account. */
    bodyPrefetchCount: z.number().int().min(0),
  }),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  readingPane: "right",
  density: "comfortable",
  remoteImages: "ask",
  allowedImageSenders: [],
  closeToTray: true,
  defaultAgentAccess: "draft",
  mcp: { enabled: true, port: 47821 },
  oauth: { googleClientId: "", googleClientSecret: "", microsoftClientId: "" },
  sync: { initialDays: 365, bodyPrefetchCount: 300 },
};

// ── MCP connection info ─────────────────────────────────────────────────────────────────────

export const McpClient = z.object({
  sessionId: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  connectedAt: z.number(),
  lastSeenAt: z.number(),
});
export type McpClient = z.infer<typeof McpClient>;

export const McpInfo = z.object({
  enabled: z.boolean(),
  /** http://127.0.0.1:<port>/mcp */
  url: z.string(),
  token: z.string(),
  clients: z.array(McpClient),
});
export type McpInfo = z.infer<typeof McpInfo>;

// ── Palette ─────────────────────────────────────────────────────────────────────────────────

/** Account, group and label colors (Tailwind 500s, readable on the dark canvas). */
export const COLOR_PALETTE = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#d946ef", // fuchsia
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#84cc16", // lime
  "#10b981", // emerald
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#64748b", // slate
] as const;
