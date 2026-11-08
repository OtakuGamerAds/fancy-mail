/**
 * The `threads` and `thread_labels` tables are a cache derived from messages, their mailbox
 * roles, their labels and the local drafts. `refreshThreads` recomputes them; nothing else
 * writes a thread's flags.
 *
 * "Live" messages are the ones outside trash and spam. A conversation's flags come from its
 * live messages when it has any (so trashing one message of a conversation does not move the
 * rest), and from all of them when everything is in the trash or spam.
 */
import type { Address, MailboxRole, ThreadSummary } from "@fancy-mail/contracts";

import { chunked, parseJson, placeholders } from "../db/sqlite.ts";
import type { Db, SqlValue } from "../db/sqlite.ts";

export interface ThreadRow {
  id: string;
  account_id: string;
  subject: string;
  snippet: string;
  participants_json: string;
  last_message_at: number;
  first_message_at: number;
  message_count: number;
  live_count: number;
  unread_count: number;
  starred: number;
  has_attachments: number;
  in_inbox: number;
  in_sent: number;
  in_drafts: number;
  in_trash: number;
  in_spam: number;
  in_archive: number;
  draft_count: number;
}

export function toThreadSummary(row: ThreadRow, labelIds: string[]): ThreadSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    subject: row.subject,
    snippet: row.snippet,
    participants: parseJson<Address[]>(row.participants_json, []),
    lastMessageAt: row.last_message_at,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    starred: row.starred === 1,
    hasAttachments: row.has_attachments === 1,
    labelIds,
    inInbox: row.in_inbox === 1,
    inSent: row.in_sent === 1,
    inTrash: row.in_trash === 1,
    inSpam: row.in_spam === 1,
    draftCount: row.draft_count,
  };
}

interface MsgRow {
  id: string;
  thread_id: string;
  account_id: string;
  subject: string;
  snippet: string;
  from_json: string | null;
  date: number;
  unread: number;
  starred: number;
  is_draft: number;
  has_attachments: number;
}

interface DraftRow {
  thread_id: string;
  account_id: string;
  subject: string;
  body_text: string;
  updated_at: number;
  to_json: string;
}

const PARTICIPANT_LIMIT = 12;

function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Recomputes the cached rows of these threads. Threads left with nothing in them are deleted. */
export function refreshThreads(db: Db, threadIds: Iterable<string>): void {
  const ids = [...new Set(threadIds)].filter(Boolean);
  if (ids.length === 0) return;
  db.tx(() => {
    for (let i = 0; i < ids.length; i += 400) refreshSlice(db, ids.slice(i, i + 400));
  });
}

function refreshSlice(db: Db, ids: string[]): void {
  const marks = placeholders(ids.length);
  const messages = db.all<MsgRow>(
    `SELECT id, thread_id, account_id, subject, snippet, from_json, date, unread, starred, is_draft, has_attachments
       FROM messages WHERE thread_id IN (${marks}) ORDER BY date, seq`,
    ...ids,
  );
  const roles = new Map<string, Set<MailboxRole | "other">>();
  for (const row of db.all<{ message_id: string; role: MailboxRole | null }>(
    `SELECT mm.message_id AS message_id, b.role AS role
       FROM message_mailboxes mm
       JOIN mailboxes b ON b.id = mm.mailbox_id
       JOIN messages m ON m.id = mm.message_id
      WHERE m.thread_id IN (${marks})`,
    ...ids,
  )) {
    let set = roles.get(row.message_id);
    if (!set) roles.set(row.message_id, (set = new Set()));
    set.add(row.role ?? "other");
  }
  const labelsByMessage = new Map<string, string[]>();
  for (const row of db.all<{ message_id: string; label_id: string }>(
    `SELECT ml.message_id AS message_id, ml.label_id AS label_id
       FROM message_labels ml JOIN messages m ON m.id = ml.message_id
      WHERE m.thread_id IN (${marks})`,
    ...ids,
  )) {
    const list = labelsByMessage.get(row.message_id);
    if (list) list.push(row.label_id);
    else labelsByMessage.set(row.message_id, [row.label_id]);
  }
  const drafts = db.all<DraftRow>(
    `SELECT thread_id, account_id, subject, body_text, updated_at, to_json FROM drafts
      WHERE thread_id IN (${marks}) AND send_state != 'sent' ORDER BY updated_at`,
    ...ids,
  );

  const messagesByThread = new Map<string, MsgRow[]>();
  for (const m of messages) {
    const list = messagesByThread.get(m.thread_id);
    if (list) list.push(m);
    else messagesByThread.set(m.thread_id, [m]);
  }
  const draftsByThread = new Map<string, DraftRow[]>();
  for (const d of drafts) {
    const list = draftsByThread.get(d.thread_id);
    if (list) list.push(d);
    else draftsByThread.set(d.thread_id, [d]);
  }

  for (const threadId of ids) {
    const all = messagesByThread.get(threadId) ?? [];
    const threadDrafts = draftsByThread.get(threadId) ?? [];
    if (all.length === 0 && threadDrafts.length === 0) {
      db.run("DELETE FROM threads WHERE id = ?", threadId);
      continue;
    }

    const rolesOf = (m: MsgRow) => roles.get(m.id) ?? new Set<MailboxRole | "other">();
    const isDead = (m: MsgRow) => rolesOf(m).has("trash") || rolesOf(m).has("spam");
    const live = all.filter((m) => !isDead(m));
    const visible = live.length > 0 ? live : all;
    const real = visible.filter((m) => m.is_draft === 0);
    const shown = real.length > 0 ? real : visible;
    const latest = shown[shown.length - 1];
    const latestDraft = threadDrafts[threadDrafts.length - 1];

    const participants: Address[] = [];
    const seen = new Set<string>();
    for (const m of real) {
      const from = parseJson<Address | null>(m.from_json, null);
      if (!from) continue;
      const key = from.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      participants.push(from);
      if (participants.length >= PARTICIPANT_LIMIT) break;
    }
    if (participants.length === 0 && latestDraft) {
      participants.push(...parseJson<Address[]>(latestDraft.to_json, []).slice(0, 3));
    }

    const anyRole = (list: MsgRow[], role: MailboxRole) => list.some((m) => rolesOf(m).has(role));
    const inInbox = anyRole(live, "inbox");
    const inSent = anyRole(live, "sent");
    const inDrafts = live.some((m) => m.is_draft === 1) || anyRole(live, "drafts");
    const inTrash = anyRole(all, "trash");
    const inSpam = anyRole(all, "spam");
    // Archived: out of the inbox, and something in it was received (not only sent mail or drafts).
    const inArchive =
      !inInbox &&
      live.some((m) => {
        if (m.is_draft === 1) return false;
        const r = rolesOf(m);
        if (r.has("sent") || r.has("drafts")) return false;
        return r.size > 0;
      });

    const labelIds = new Set<string>();
    for (const m of visible) for (const l of labelsByMessage.get(m.id) ?? []) labelIds.add(l);

    const accountId = all[0]?.account_id ?? latestDraft!.account_id;
    const subject = latest?.subject || latestDraft?.subject || "";
    const snippet = latest ? latest.snippet : snippetOf(latestDraft?.body_text ?? "");
    const lastAt = latest ? Math.max(...shown.map((m) => m.date)) : latestDraft!.updated_at;
    const firstAt = latest ? Math.min(...shown.map((m) => m.date)) : threadDrafts[0]!.updated_at;

    db.run(
      `INSERT INTO threads (id, account_id, subject, snippet, participants_json, last_message_at, first_message_at,
         message_count, live_count, unread_count, starred, has_attachments, in_inbox, in_sent, in_drafts, in_trash,
         in_spam, in_archive, draft_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id, subject = excluded.subject, snippet = excluded.snippet,
         participants_json = excluded.participants_json, last_message_at = excluded.last_message_at,
         first_message_at = excluded.first_message_at, message_count = excluded.message_count,
         live_count = excluded.live_count, unread_count = excluded.unread_count, starred = excluded.starred,
         has_attachments = excluded.has_attachments, in_inbox = excluded.in_inbox, in_sent = excluded.in_sent,
         in_drafts = excluded.in_drafts, in_trash = excluded.in_trash, in_spam = excluded.in_spam,
         in_archive = excluded.in_archive, draft_count = excluded.draft_count`,
      threadId,
      accountId,
      subject,
      snippet,
      JSON.stringify(participants),
      lastAt,
      firstAt,
      real.length,
      live.length,
      real.filter((m) => m.unread === 1).length,
      visible.some((m) => m.starred === 1) ? 1 : 0,
      visible.some((m) => m.has_attachments === 1) ? 1 : 0,
      inInbox ? 1 : 0,
      inSent ? 1 : 0,
      inDrafts ? 1 : 0,
      inTrash ? 1 : 0,
      inSpam ? 1 : 0,
      inArchive ? 1 : 0,
      threadDrafts.length,
    );

    const existing = new Set(
      db.all<{ label_id: string }>("SELECT label_id FROM thread_labels WHERE thread_id = ?", threadId).map((r) => r.label_id),
    );
    for (const labelId of existing) {
      if (!labelIds.has(labelId)) db.run("DELETE FROM thread_labels WHERE thread_id = ? AND label_id = ?", threadId, labelId);
    }
    for (const labelId of labelIds) {
      if (!existing.has(labelId)) db.run("INSERT INTO thread_labels (thread_id, label_id) VALUES (?, ?)", threadId, labelId);
    }
  }
}

export function createThreadsStore(db: Db) {
  return {
    get(id: string): ThreadRow | null {
      return db.get<ThreadRow>("SELECT * FROM threads WHERE id = ?", id) ?? null;
    },

    byIds(ids: string[]): ThreadRow[] {
      if (ids.length === 0) return [];
      return chunked(ids, 500, (slice) =>
        db.all<ThreadRow>(`SELECT * FROM threads WHERE id IN (${placeholders(slice.length)})`, ...slice),
      );
    },

    labelIds(threadIds: string[]): Map<string, string[]> {
      const out = new Map<string, string[]>();
      for (const id of threadIds) out.set(id, []);
      if (threadIds.length === 0) return out;
      const rows = chunked(threadIds, 500, (slice) =>
        db.all<{ thread_id: string; label_id: string }>(
          `SELECT tl.thread_id AS thread_id, tl.label_id AS label_id
             FROM thread_labels tl JOIN labels l ON l.id = tl.label_id
            WHERE tl.thread_id IN (${placeholders(slice.length)})
            ORDER BY l.sort_order, l.name`,
          ...slice,
        ),
      );
      for (const r of rows) out.get(r.thread_id)?.push(r.label_id);
      return out;
    },

    summaries(ids: string[]): ThreadSummary[] {
      const rows = this.byIds(ids);
      const labels = this.labelIds(rows.map((r) => r.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [toThreadSummary(row, labels.get(id) ?? [])] : [];
      });
    },

    /** An empty thread row for a draft that starts a new conversation (refreshThreads fills it). */
    insertPlaceholder(id: string, accountId: string, at: number): void {
      db.run(
        `INSERT OR IGNORE INTO threads (id, account_id, last_message_at, first_message_at) VALUES (?, ?, ?, ?)`,
        id,
        accountId,
        at,
        at,
      );
    },

    /**
     * The page and total of a compiled search. The page and the count may use differently
     * planned (but equivalent) conditions.
     */
    search(
      list: { where: string; params: SqlValue[] },
      count: { where: string; params: SqlValue[] },
      page: { after: { at: number; id: string } | null; limit: number },
    ): { rows: ThreadRow[]; total: number } {
      const cursorClause = page.after ? "AND (t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))" : "";
      const cursorParams: SqlValue[] = page.after ? [page.after.at, page.after.at, page.after.id] : [];
      const rows = db.all<ThreadRow>(
        `SELECT t.* FROM threads t WHERE (${list.where}) ${cursorClause} ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?`,
        ...list.params,
        ...cursorParams,
        page.limit,
      );
      const total = Number(
        db.value(`SELECT COUNT(*) FROM (SELECT 1 FROM threads t WHERE (${count.where}) LIMIT 10000)`, ...count.params) ?? 0,
      );
      return { rows, total };
    },

    /** Matching conversations per account and per label. */
    facets(where: string, params: SqlValue[]): { byAccount: Map<string, number>; byLabel: Map<string, number> } {
      const byAccount = new Map(
        db
          .all<{ id: string; n: number }>(`SELECT t.account_id AS id, COUNT(*) AS n FROM threads t WHERE (${where}) GROUP BY t.account_id`, ...params)
          .map((r) => [r.id, Number(r.n)] as const),
      );
      const byLabel = new Map(
        db
          .all<{ id: string; n: number }>(
            `SELECT tl.label_id AS id, COUNT(*) AS n FROM threads t JOIN thread_labels tl ON tl.thread_id = t.id WHERE (${where}) GROUP BY tl.label_id`,
            ...params,
          )
          .map((r) => [r.id, Number(r.n)] as const),
      );
      return { byAccount, byLabel };
    },

    /** How many messages an FTS5 expression matches (cheap; to choose a query plan). */
    textHits(match: string): number {
      return Number(db.value("SELECT COUNT(*) FROM message_fts WHERE message_fts MATCH ?", match) ?? 0);
    },

    /** Thread ids matching a compiled search (all of them, up to `limit`). */
    searchIds(where: string, params: SqlValue[], limit: number): string[] {
      return db
        .all<{ id: string }>(
          `SELECT t.id FROM threads t WHERE (${where}) ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?`,
          ...params,
          limit,
        )
        .map((r) => r.id);
    },

    allIdsForAccount(accountId: string): string[] {
      return db.all<{ id: string }>("SELECT id FROM threads WHERE account_id = ?", accountId).map((r) => r.id);
    },
  };
}

export type ThreadsStore = ReturnType<typeof createThreadsStore>;
