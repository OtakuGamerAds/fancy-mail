import type { Activity, Actor, MailboxRole } from "@fancy-mail/contracts";

import { bool, parseJson } from "../db/sqlite.ts";
import type { Db } from "../db/sqlite.ts";
import { newId } from "../db/ids.ts";
import type { ActivityRecord, OutboxRecord } from "./types.ts";

// ── Activity ────────────────────────────────────────────────────────────────────────────────

interface ActivityRow {
  id: string;
  at: number;
  actor_json: string;
  summary: string;
  kind: string;
  thread_ids_json: string;
  account_ids_json: string;
  undo_json: string | null;
  undone_at: number | null;
  undone_by_json: string | null;
  is_demo: number;
}

function toActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    at: row.at,
    actor: parseJson<Actor>(row.actor_json, { kind: "user" }),
    summary: row.summary,
    kind: row.kind,
    threadIds: parseJson<string[]>(row.thread_ids_json, []),
    accountIds: parseJson<string[]>(row.account_ids_json, []),
    undo: parseJson<unknown | null>(row.undo_json, null),
    undoneAt: row.undone_at,
    undoneBy: parseJson<Actor | null>(row.undone_by_json, null),
    isDemo: row.is_demo === 1,
  };
}

export function toContractActivity(a: ActivityRecord): Activity {
  return {
    id: a.id,
    at: a.at,
    actor: a.actor,
    summary: a.summary,
    kind: a.kind,
    threadIds: a.threadIds,
    undoable: a.undo !== null && a.undoneAt === null,
    undoneAt: a.undoneAt,
  };
}

export function createActivityStore(db: Db) {
  return {
    get(id: string): ActivityRecord | null {
      const row = db.get<ActivityRow>("SELECT * FROM activity WHERE id = ?", id);
      return row ? toActivityRecord(row) : null;
    },

    insert(a: ActivityRecord): void {
      db.run(
        `INSERT INTO activity (id, at, actor_json, summary, kind, thread_ids_json, account_ids_json, undo_json, undone_at,
           undone_by_json, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id,
        a.at,
        JSON.stringify(a.actor),
        a.summary,
        a.kind,
        JSON.stringify(a.threadIds),
        JSON.stringify(a.accountIds),
        a.undo === null ? null : JSON.stringify(a.undo),
        a.undoneAt,
        a.undoneBy ? JSON.stringify(a.undoneBy) : null,
        bool(a.isDemo),
      );
    },

    markUndone(id: string, at: number, by: Actor): void {
      db.run("UPDATE activity SET undone_at = ?, undone_by_json = ? WHERE id = ?", at, JSON.stringify(by), id);
    },

    /** Newest first; `before` is the (at, id) of the last item of the previous page. */
    page(before: { at: number; id: string } | null, limit: number): ActivityRecord[] {
      const rows = before
        ? db.all<ActivityRow>(
            "SELECT * FROM activity WHERE (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?",
            before.at,
            before.at,
            before.id,
            limit,
          )
        : db.all<ActivityRow>("SELECT * FROM activity ORDER BY at DESC, id DESC LIMIT ?", limit);
      return rows.map(toActivityRecord);
    },

    deleteDemo(): void {
      db.run("DELETE FROM activity WHERE is_demo = 1");
    },

    /** Keeps the log bounded: drops entries older than `at` (and beyond the newest `keep`). */
    prune(olderThan: number, keep: number): void {
      db.run(
        `DELETE FROM activity WHERE at < ? AND id NOT IN (SELECT id FROM activity ORDER BY at DESC LIMIT ?)`,
        olderThan,
        keep,
      );
    },
  };
}

export type ActivityStore = ReturnType<typeof createActivityStore>;

// ── Outbox ──────────────────────────────────────────────────────────────────────────────────
//
// Local changes waiting to be applied on the server, in order, per account. The sync engine
// drains them; it should resolve current locations from the database when it runs an op (the
// payload says what the user did and where things were at that moment).

export interface OutboxMessageRef {
  id: string;
  remoteId: string | null;
  messageIdHeader: string | null;
  gmThreadId: string | null;
}

export interface OutboxMailboxRef {
  id: string;
  path: string;
  role: MailboxRole | null;
}

export interface OutboxMessageChange {
  message: OutboxMessageRef;
  /** Mailboxes the message was put in (IMAP: move/copy target; Gmail: system label added). */
  addTo: OutboxMailboxRef[];
  /** Mailboxes it left, with the uid it had there (null when unknown). */
  removeFrom: (OutboxMailboxRef & { uid: number | null })[];
  /** \Seen set (true) or cleared (false); absent: unchanged. */
  seen?: boolean;
  /** \Flagged set or cleared; absent: unchanged. */
  flagged?: boolean;
  /** Label names (Gmail labels, IMAP keywords). */
  addLabels: string[];
  removeLabels: string[];
}

export type OutboxPayload =
  /** One user action (or its undo) on some messages of one account. */
  | { kind: "modify"; action: string; changes: OutboxMessageChange[] }
  | { kind: "labelRename"; from: string; to: string }
  | { kind: "labelDelete"; name: string }
  /** A mailbox the app created locally (e.g. "Archive" for an IMAP account without one). */
  | { kind: "createMailbox"; mailbox: OutboxMailboxRef }
  /** A draft stored on the server was deleted locally (or sent). */
  | { kind: "deleteDraft"; draftId: string; remoteUid: number | null; mailboxId: string | null };

export type OutboxKind = OutboxPayload["kind"];

interface OutboxRow {
  seq: number;
  id: string;
  account_id: string;
  kind: string;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number;
  state: string;
}

function toOutboxRecord(row: OutboxRow): OutboxRecord {
  return {
    seq: row.seq,
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    payload: parseJson<unknown>(row.payload_json, null),
    createdAt: row.created_at,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    state: row.state as OutboxRecord["state"],
  };
}

export function createOutboxStore(db: Db) {
  return {
    enqueue(accountId: string, payload: OutboxPayload, at: number = Date.now()): string {
      const id = newId("op");
      db.run(
        "INSERT INTO outbox (id, account_id, kind, payload_json, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        accountId,
        payload.kind,
        JSON.stringify(payload),
        at,
        at,
      );
      return id;
    },

    /** Pending ops of an account, oldest first, that are due at `now`. */
    due(accountId: string, now: number = Date.now(), limit = 50): OutboxRecord[] {
      return db
        .all<OutboxRow>(
          "SELECT * FROM outbox WHERE account_id = ? AND state = 'pending' AND next_attempt_at <= ? ORDER BY seq LIMIT ?",
          accountId,
          now,
          limit,
        )
        .map(toOutboxRecord);
    },

    pending(accountId: string): OutboxRecord[] {
      return db
        .all<OutboxRow>("SELECT * FROM outbox WHERE account_id = ? AND state = 'pending' ORDER BY seq", accountId)
        .map(toOutboxRecord);
    },

    failed(accountId: string): OutboxRecord[] {
      return db
        .all<OutboxRow>("SELECT * FROM outbox WHERE account_id = ? AND state = 'failed' ORDER BY seq", accountId)
        .map(toOutboxRecord);
    },

    complete(id: string): void {
      db.run("DELETE FROM outbox WHERE id = ?", id);
    },

    retryLater(id: string, error: string, nextAttemptAt: number): void {
      db.run(
        "UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?",
        error,
        nextAttemptAt,
        id,
      );
    },

    fail(id: string, error: string): void {
      db.run("UPDATE outbox SET attempts = attempts + 1, last_error = ?, state = 'failed' WHERE id = ?", error, id);
    },

    deleteForAccount(accountId: string): void {
      db.run("DELETE FROM outbox WHERE account_id = ?", accountId);
    },

    count(accountId?: string): number {
      return Number(
        accountId
          ? db.value("SELECT COUNT(*) FROM outbox WHERE account_id = ?", accountId)
          : db.value("SELECT COUNT(*) FROM outbox"),
      );
    },
  };
}

export type OutboxStore = ReturnType<typeof createOutboxStore>;
