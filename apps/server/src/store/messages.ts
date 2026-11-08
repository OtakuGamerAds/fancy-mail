/**
 * Messages, where they are (message_mailboxes), their labels, bodies, attachments, and the
 * full-text index. Every function that changes what a message says keeps message_fts in step.
 */
import type { Address, AttachmentMeta, MailboxRole, Message } from "@fancy-mail/contracts";

import { bool, chunked, parseJson, placeholders } from "../db/sqlite.ts";
import type { Db, SqlValue } from "../db/sqlite.ts";
import type { AttachmentRecord, BodyState, MessageLocation, MessagePatch, MessageRecord, NewMessage } from "./types.ts";

interface MessageRow {
  seq: number;
  id: string;
  account_id: string;
  thread_id: string;
  remote_id: string | null;
  gm_thread_id: string | null;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_json: string;
  subject: string;
  from_json: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to_json: string;
  date: number;
  snippet: string;
  size: number;
  unread: number;
  starred: number;
  is_draft: number;
  has_attachments: number;
  body_state: string;
  body_error: string | null;
  body_attempts: number;
  restore_json: string | null;
  created_at: number;
}

function toRecord(row: MessageRow): MessageRecord {
  return {
    seq: row.seq,
    id: row.id,
    accountId: row.account_id,
    threadId: row.thread_id,
    remoteId: row.remote_id,
    gmThreadId: row.gm_thread_id,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: parseJson<string[]>(row.references_json, []),
    subject: row.subject,
    from: parseJson<Address | null>(row.from_json, null),
    to: parseJson<Address[]>(row.to_json, []),
    cc: parseJson<Address[]>(row.cc_json, []),
    bcc: parseJson<Address[]>(row.bcc_json, []),
    replyTo: parseJson<Address[]>(row.reply_to_json, []),
    date: row.date,
    snippet: row.snippet,
    size: row.size,
    unread: row.unread === 1,
    starred: row.starred === 1,
    isDraft: row.is_draft === 1,
    hasAttachments: row.has_attachments === 1,
    bodyState: row.body_state as BodyState,
    bodyError: row.body_error,
    bodyAttempts: row.body_attempts,
    restoreTo: parseJson<string[] | null>(row.restore_json, null),
    createdAt: row.created_at,
  };
}

interface AttachmentRow {
  id: string;
  message_id: string;
  part: string | null;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
  inline: number;
  local_path: string | null;
  sort_order: number;
}

function toAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    part: row.part,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    contentId: row.content_id,
    inline: row.inline === 1,
    localPath: row.local_path,
    sortOrder: row.sort_order,
  };
}

export function attachmentMeta(a: AttachmentRecord): AttachmentMeta {
  return {
    id: a.id,
    messageId: a.messageId,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    contentId: a.contentId,
    inline: a.inline,
    downloaded: a.localPath !== null,
  };
}

/** "Name <address>" for the people columns of the index. */
export function addressText(addresses: (Address | null)[]): string {
  return addresses
    .filter((a): a is Address => a !== null)
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(", ");
}

/** Text for the index from HTML when a message has no text part (tags and entities out). */
export function roughHtmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

const MESSAGE_COLUMNS: Partial<Record<keyof MessagePatch, string>> = {
  threadId: "thread_id",
  remoteId: "remote_id",
  gmThreadId: "gm_thread_id",
  messageIdHeader: "message_id_header",
  inReplyTo: "in_reply_to",
  references: "references_json",
  subject: "subject",
  from: "from_json",
  to: "to_json",
  cc: "cc_json",
  bcc: "bcc_json",
  replyTo: "reply_to_json",
  date: "date",
  snippet: "snippet",
  size: "size",
  unread: "unread",
  starred: "starred",
  isDraft: "is_draft",
  hasAttachments: "has_attachments",
  bodyState: "body_state",
  bodyError: "body_error",
  bodyAttempts: "body_attempts",
  restoreTo: "restore_json",
};

const JSON_KEYS = new Set<keyof MessagePatch>(["references", "from", "to", "cc", "bcc", "replyTo", "restoreTo"]);
const BOOL_KEYS = new Set<keyof MessagePatch>(["unread", "starred", "isDraft", "hasAttachments"]);
/** Changing any of these changes what the index holds. */
const INDEXED_KEYS = new Set<keyof MessagePatch>(["subject", "from", "to", "cc", "bcc"]);

export interface NewAttachment {
  id: string;
  messageId: string;
  part: string | null;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  localPath: string | null;
  sortOrder?: number;
}

export interface LabelRow {
  messageId: string;
  labelId: string;
}

export function createMessagesStore(db: Db) {
  function reindexSeqs(rows: { seq: number; id: string }[]): void {
    for (const { seq, id } of rows) {
      const m = db.get<MessageRow>("SELECT * FROM messages WHERE seq = ?", seq);
      if (!m) continue;
      const body = db.get<{ text: string | null; html: string | null }>(
        "SELECT text, html FROM message_bodies WHERE message_id = ?",
        id,
      );
      const names = db
        .all<{ filename: string }>("SELECT filename FROM attachments WHERE message_id = ? AND inline = 0", id)
        .map((a) => a.filename)
        .join(" ");
      const record = toRecord(m);
      const bodyText = body?.text ?? (body?.html ? roughHtmlText(body.html) : record.snippet);
      db.run("DELETE FROM message_fts WHERE rowid = ?", seq);
      db.run(
        "INSERT INTO message_fts (rowid, subject, sender, recipients, cc, body, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)",
        seq,
        record.subject,
        addressText([record.from, ...record.replyTo]),
        addressText([...record.to, ...record.bcc]),
        addressText(record.cc),
        bodyText,
        names,
      );
    }
  }

  const store = {
    get(id: string): MessageRecord | null {
      const row = db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },

    byIds(ids: string[]): MessageRecord[] {
      if (ids.length === 0) return [];
      return chunked(ids, 500, (slice) =>
        db.all<MessageRow>(`SELECT * FROM messages WHERE id IN (${placeholders(slice.length)})`, ...slice).map(toRecord),
      );
    },

    /** Oldest first. */
    forThread(threadId: string): MessageRecord[] {
      return db.all<MessageRow>("SELECT * FROM messages WHERE thread_id = ? ORDER BY date, seq", threadId).map(toRecord);
    },

    forThreads(threadIds: string[]): MessageRecord[] {
      if (threadIds.length === 0) return [];
      return chunked(threadIds, 500, (slice) =>
        db
          .all<MessageRow>(
            `SELECT * FROM messages WHERE thread_id IN (${placeholders(slice.length)}) ORDER BY date, seq`,
            ...slice,
          )
          .map(toRecord),
      );
    },

    byRemoteId(accountId: string, remoteId: string): MessageRecord | null {
      const row = db.get<MessageRow>("SELECT * FROM messages WHERE account_id = ? AND remote_id = ?", accountId, remoteId);
      return row ? toRecord(row) : null;
    },

    byMessageIdHeader(accountId: string, header: string): MessageRecord | null {
      const row = db.get<MessageRow>(
        "SELECT * FROM messages WHERE account_id = ? AND message_id_header = ? ORDER BY seq LIMIT 1",
        accountId,
        header,
      );
      return row ? toRecord(row) : null;
    },

    /** The thread of the first message in this account carrying one of these Message-IDs. */
    threadIdForHeaders(accountId: string, headers: string[]): string | null {
      const wanted = headers.filter(Boolean);
      if (wanted.length === 0) return null;
      const row = db.get<{ thread_id: string }>(
        `SELECT thread_id FROM messages WHERE account_id = ? AND message_id_header IN (${placeholders(wanted.length)}) ORDER BY seq LIMIT 1`,
        accountId,
        ...wanted,
      );
      return row?.thread_id ?? null;
    },

    insert(message: NewMessage): number {
      const result = db.run(
        `INSERT INTO messages (id, account_id, thread_id, remote_id, gm_thread_id, message_id_header, in_reply_to,
           references_json, subject, from_json, to_json, cc_json, bcc_json, reply_to_json, date, snippet, size,
           unread, starred, is_draft, has_attachments, body_state, body_error, body_attempts, restore_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.accountId,
        message.threadId,
        message.remoteId,
        message.gmThreadId,
        message.messageIdHeader,
        message.inReplyTo,
        JSON.stringify(message.references),
        message.subject,
        message.from ? JSON.stringify(message.from) : null,
        JSON.stringify(message.to),
        JSON.stringify(message.cc),
        JSON.stringify(message.bcc),
        JSON.stringify(message.replyTo),
        message.date,
        message.snippet,
        message.size,
        bool(message.unread),
        bool(message.starred),
        bool(message.isDraft),
        bool(message.hasAttachments),
        message.bodyState,
        message.bodyError ?? null,
        message.bodyAttempts ?? 0,
        message.restoreTo ? JSON.stringify(message.restoreTo) : null,
        message.createdAt ?? Date.now(),
      );
      reindexSeqs([{ seq: result.lastInsertRowid, id: message.id }]);
      return result.lastInsertRowid;
    },

    update(id: string, patch: MessagePatch): void {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      let reindex = false;
      for (const key of Object.keys(patch) as (keyof MessagePatch)[]) {
        const value = patch[key];
        const column = MESSAGE_COLUMNS[key];
        if (value === undefined || !column) continue;
        sets.push(`${column} = ?`);
        if (JSON_KEYS.has(key)) params.push(value === null ? null : JSON.stringify(value));
        else if (BOOL_KEYS.has(key)) params.push(bool(Boolean(value)));
        else params.push(value as SqlValue);
        if (INDEXED_KEYS.has(key)) reindex = true;
      }
      if (sets.length === 0) return;
      db.run(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
      if (reindex) store.reindex([id]);
    },

    setFlags(ids: string[], flags: { unread?: boolean; starred?: boolean }): void {
      if (ids.length === 0) return;
      for (const slice of chunk(ids, 500)) {
        if (flags.unread !== undefined) {
          db.run(`UPDATE messages SET unread = ? WHERE id IN (${placeholders(slice.length)})`, bool(flags.unread), ...slice);
        }
        if (flags.starred !== undefined) {
          db.run(`UPDATE messages SET starred = ? WHERE id IN (${placeholders(slice.length)})`, bool(flags.starred), ...slice);
        }
      }
    },

    /** Deletes messages (locations, labels, bodies, attachments and index rows go with them). */
    delete(ids: string[]): void {
      for (const slice of chunk(ids, 500)) {
        db.run(`DELETE FROM messages WHERE id IN (${placeholders(slice.length)})`, ...slice);
      }
    },

    /** Rebuilds the index rows of these messages from what is stored now. */
    reindex(ids: string[]): void {
      if (ids.length === 0) return;
      const rows = chunked(ids, 500, (slice) =>
        db.all<{ seq: number; id: string }>(`SELECT seq, id FROM messages WHERE id IN (${placeholders(slice.length)})`, ...slice),
      );
      reindexSeqs(rows);
    },

    // ── Bodies ──────────────────────────────────────────────────────────────────────────────

    body(id: string): { text: string | null; html: string | null; fetchedAt: number } | null {
      const row = db.get<{ text: string | null; html: string | null; fetched_at: number }>(
        "SELECT text, html, fetched_at FROM message_bodies WHERE message_id = ?",
        id,
      );
      return row ? { text: row.text, html: row.html, fetchedAt: row.fetched_at } : null;
    },

    bodies(ids: string[]): Map<string, { text: string | null; html: string | null }> {
      const out = new Map<string, { text: string | null; html: string | null }>();
      for (const slice of chunk(ids, 500)) {
        for (const row of db.all<{ message_id: string; text: string | null; html: string | null }>(
          `SELECT message_id, text, html FROM message_bodies WHERE message_id IN (${placeholders(slice.length)})`,
          ...slice,
        )) {
          out.set(row.message_id, { text: row.text, html: row.html });
        }
      }
      return out;
    },

    /** Stores the body, marks it ready and re-indexes the message. */
    setBody(id: string, body: { text: string | null; html: string | null }, fetchedAt: number = Date.now()): void {
      db.run(
        `INSERT INTO message_bodies (message_id, text, html, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET text = excluded.text, html = excluded.html, fetched_at = excluded.fetched_at`,
        id,
        body.text,
        body.html,
        fetchedAt,
      );
      db.run("UPDATE messages SET body_state = 'ready', body_error = NULL WHERE id = ?", id);
      store.reindex([id]);
    },

    /** Messages whose body is not on this computer yet. */
    missingBodies(ids: string[]): string[] {
      return store.byIds(ids).filter((m) => m.bodyState === "none").map((m) => m.id);
    },

    // ── Locations ───────────────────────────────────────────────────────────────────────────

    locations(ids: string[]): MessageLocation[] {
      if (ids.length === 0) return [];
      return chunked(ids, 500, (slice) =>
        db.all<{ messageId: string; mailboxId: string; uid: number | null; role: MailboxRole | null; path: string }>(
          `SELECT mm.message_id AS messageId, mm.mailbox_id AS mailboxId, mm.uid AS uid, b.role AS role, b.path AS path
             FROM message_mailboxes mm JOIN mailboxes b ON b.id = mm.mailbox_id
            WHERE mm.message_id IN (${placeholders(slice.length)})`,
          ...slice,
        ),
      );
    },

    addLocation(messageId: string, mailboxId: string, uid: number | null = null): void {
      db.run(
        `INSERT INTO message_mailboxes (message_id, mailbox_id, uid) VALUES (?, ?, ?)
         ON CONFLICT(message_id, mailbox_id) DO UPDATE SET uid = COALESCE(excluded.uid, message_mailboxes.uid)`,
        messageId,
        mailboxId,
        uid,
      );
    },

    removeLocation(messageId: string, mailboxId: string): void {
      db.run("DELETE FROM message_mailboxes WHERE message_id = ? AND mailbox_id = ?", messageId, mailboxId);
    },

    setLocationUid(messageId: string, mailboxId: string, uid: number | null): void {
      db.run("UPDATE message_mailboxes SET uid = ? WHERE message_id = ? AND mailbox_id = ?", uid, messageId, mailboxId);
    },

    /** The message at a uid in a mailbox (sync engine). */
    byUid(mailboxId: string, uid: number): MessageRecord | null {
      const row = db.get<MessageRow>(
        "SELECT m.* FROM message_mailboxes mm JOIN messages m ON m.id = mm.message_id WHERE mm.mailbox_id = ? AND mm.uid = ?",
        mailboxId,
        uid,
      );
      return row ? toRecord(row) : null;
    },

    // ── Labels ──────────────────────────────────────────────────────────────────────────────

    labels(ids: string[]): LabelRow[] {
      if (ids.length === 0) return [];
      return chunked(ids, 500, (slice) =>
        db.all<LabelRow>(
          `SELECT message_id AS messageId, label_id AS labelId FROM message_labels WHERE message_id IN (${placeholders(slice.length)})`,
          ...slice,
        ),
      );
    },

    addLabel(messageId: string, labelId: string): void {
      db.run("INSERT OR IGNORE INTO message_labels (message_id, label_id) VALUES (?, ?)", messageId, labelId);
    },

    removeLabel(messageId: string, labelId: string): void {
      db.run("DELETE FROM message_labels WHERE message_id = ? AND label_id = ?", messageId, labelId);
    },

    // ── Attachments ─────────────────────────────────────────────────────────────────────────

    attachments(messageIds: string[]): AttachmentRecord[] {
      if (messageIds.length === 0) return [];
      return chunked(messageIds, 500, (slice) =>
        db
          .all<AttachmentRow>(
            `SELECT * FROM attachments WHERE message_id IN (${placeholders(slice.length)}) ORDER BY message_id, sort_order`,
            ...slice,
          )
          .map(toAttachment),
      );
    },

    attachment(id: string): AttachmentRecord | null {
      const row = db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", id);
      return row ? toAttachment(row) : null;
    },

    attachmentByContentId(messageId: string, contentId: string): AttachmentRecord | null {
      const bare = contentId.replace(/^<|>$/g, "");
      const row = db.get<AttachmentRow>(
        "SELECT * FROM attachments WHERE message_id = ? AND (content_id = ? OR content_id = ?) LIMIT 1",
        messageId,
        bare,
        `<${bare}>`,
      );
      return row ? toAttachment(row) : null;
    },

    insertAttachment(a: NewAttachment): void {
      db.run(
        `INSERT INTO attachments (id, message_id, part, filename, mime_type, size, content_id, inline, local_path, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.messageId,
        a.part,
        a.filename,
        a.mimeType,
        a.size,
        a.contentId,
        bool(a.inline),
        a.localPath,
        a.sortOrder ?? 0,
      );
    },

    setAttachmentPath(id: string, localPath: string | null): void {
      db.run("UPDATE attachments SET local_path = ? WHERE id = ?", localPath, id);
    },

    /** Local files of every attachment of an account (to delete them with it). */
    attachmentPathsForAccount(accountId: string): string[] {
      return db
        .all<{ local_path: string }>(
          `SELECT a.local_path FROM attachments a JOIN messages m ON m.id = a.message_id
            WHERE m.account_id = ? AND a.local_path IS NOT NULL`,
          accountId,
        )
        .map((r) => r.local_path);
    },
  };

  return store;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The contract Message, from the stored pieces. */
export function toContractMessage(
  m: MessageRecord,
  labelIds: string[],
  attachments: AttachmentRecord[],
  body: { text: string | null; html: string | null } | null,
): Message {
  return {
    id: m.id,
    threadId: m.threadId,
    accountId: m.accountId,
    messageIdHeader: m.messageIdHeader,
    inReplyTo: m.inReplyTo,
    references: m.references,
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    replyTo: m.replyTo,
    subject: m.subject,
    date: m.date,
    snippet: m.snippet,
    unread: m.unread,
    starred: m.starred,
    isDraft: m.isDraft,
    labelIds,
    attachments: attachments.map(attachmentMeta),
    body: m.bodyState === "ready" && body ? { text: body.text, html: body.html } : null,
  };
}

export type MessagesStore = ReturnType<typeof createMessagesStore>;
