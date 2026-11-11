/**
 * What the store returns: the contract types plus the columns only the server sees.
 */
import type {
  Account,
  Actor,
  Address,
  AgentAccess,
  AuthKind,
  DraftAttachment,
  DraftMode,
  DraftSendState,
  MailboxRole,
  Provider,
  ServerEndpoint,
  AccountStatus,
} from "@fancy-mail/contracts";

export interface AccountRecord extends Omit<Account, "unreadInboxCount"> {
  username: string;
  paused: boolean;
  isDemo: boolean;
}

export interface NewAccount {
  id: string;
  email: string;
  displayName: string;
  /** Defaults to displayName. */
  senderName?: string;
  username: string;
  provider: Provider;
  authKind: AuthKind;
  groupId: string | null;
  color: string;
  sortOrder: number;
  agentAccess: AgentAccess;
  signature: string;
  imap: ServerEndpoint | null;
  smtp: ServerEndpoint | null;
  status: AccountStatus;
  paused: boolean;
  isDemo: boolean;
  createdAt: number;
}

export type AccountPatch = Partial<
  Pick<
    NewAccount,
    | "email"
    | "displayName"
    | "senderName"
    | "username"
    | "provider"
    | "authKind"
    | "groupId"
    | "color"
    | "sortOrder"
    | "agentAccess"
    | "signature"
    | "imap"
    | "smtp"
    | "paused"
  >
>;

export interface GroupRecord {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt: number;
}

export interface LabelRecord {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  createdAt: number;
}

export interface MailboxRecord {
  id: string;
  accountId: string;
  path: string;
  name: string;
  role: MailboxRole | null;
  delimiter: string | null;
  specialUse: string | null;
  uidvalidity: number | null;
  uidnext: number | null;
  highestmodseq: string | null;
  /** The sync engine's own bookkeeping for this mailbox. */
  sync: Record<string, unknown> | null;
  selectable: boolean;
  /** Created by the app (e.g. a local "Archive") and not confirmed on the server yet. */
  createdLocally: boolean;
}

export type NewMailbox = Omit<MailboxRecord, "uidvalidity" | "uidnext" | "highestmodseq" | "sync" | "delimiter" | "specialUse" | "selectable" | "createdLocally"> &
  Partial<Pick<MailboxRecord, "uidvalidity" | "uidnext" | "highestmodseq" | "sync" | "delimiter" | "specialUse" | "selectable" | "createdLocally">>;

export type BodyState = "none" | "ready" | "failed";

export interface MessageRecord {
  seq: number;
  id: string;
  accountId: string;
  threadId: string;
  /** Gmail X-GM-MSGID, or the Message-ID header. */
  remoteId: string | null;
  gmThreadId: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  date: number;
  snippet: string;
  size: number;
  unread: boolean;
  starred: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  bodyState: BodyState;
  bodyError: string | null;
  bodyAttempts: number;
  /** Mailbox ids it was in before it went to the trash or spam (for restore / not spam). */
  restoreTo: string[] | null;
  createdAt: number;
}

export type NewMessage = Omit<MessageRecord, "seq" | "createdAt" | "bodyError" | "bodyAttempts" | "restoreTo"> &
  Partial<Pick<MessageRecord, "createdAt" | "bodyError" | "bodyAttempts" | "restoreTo">>;

export type MessagePatch = Partial<Omit<MessageRecord, "seq" | "id" | "accountId" | "createdAt">>;

/** Where a message is on the server. */
export interface MessageLocation {
  messageId: string;
  mailboxId: string;
  uid: number | null;
  role: MailboxRole | null;
  path: string;
}

export interface AttachmentRecord {
  id: string;
  messageId: string;
  /** The IMAP body part id ("2", "1.2"), null when unknown. */
  part: string | null;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  localPath: string | null;
  sortOrder: number;
}

export interface DraftRecord {
  id: string;
  accountId: string;
  mode: DraftMode;
  /** The thread the draft is listed in: the one it answers, or its own for a new message. */
  threadId: string;
  sourceMessageId: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyText: string;
  attachments: DraftAttachment[];
  createdBy: Actor;
  createdAt: number;
  updatedAt: number;
  sendState: DraftSendState;
  sendError: string | null;
  remoteUid: number | null;
  remoteMailboxId: string | null;
}

export interface UploadRecord {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: number;
}

export interface ActivityRecord {
  id: string;
  at: number;
  actor: Actor;
  summary: string;
  kind: string;
  threadIds: string[];
  accountIds: string[];
  /** The inverse operations (null: not undoable). */
  undo: unknown | null;
  undoneAt: number | null;
  undoneBy: Actor | null;
  isDemo: boolean;
}

export interface OutboxRecord {
  seq: number;
  id: string;
  accountId: string;
  kind: string;
  payload: unknown;
  createdAt: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
  state: "pending" | "failed";
}
