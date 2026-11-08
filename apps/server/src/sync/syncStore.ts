/**
 * SQL only the sync engine needs, on top of the store (kept here so the store files stay as
 * they are). No business rules.
 */
import { newId } from "../db/ids.ts";
import { chunked, parseJson, placeholders } from "../db/sqlite.ts";
import type { Db } from "../db/sqlite.ts";
import type { OutboxPayload } from "../store/activity.ts";
import type { Store } from "../store/index.ts";
import type { LabelRecord } from "../store/types.ts";

export interface IndexRow {
  thread_id: string;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_json: string;
  subject: string;
  date: number;
  from_json: string | null;
  to_json: string;
  cc_json: string;
}

export function createSyncStore(db: Db, store: Store) {
  const self = {
    /** Message ids that local changes still have to reach the server for (pending or waiting to retry). */
    pendingMessageIds(accountId: string): Set<string> {
      const out = new Set<string>();
      for (const row of db.all<{ payload_json: string }>(
        "SELECT payload_json FROM outbox WHERE account_id = ? AND state = 'pending' AND kind = 'modify'",
        accountId,
      )) {
        const payload = parseJson<OutboxPayload | null>(row.payload_json, null);
        if (payload?.kind === "modify") for (const c of payload.changes) out.add(c.message.id);
      }
      return out;
    },

    pendingCount(accountId: string): number {
      return Number(db.value("SELECT COUNT(*) FROM outbox WHERE account_id = ? AND state = 'pending'", accountId) ?? 0);
    },

    failedCount(accountId: string): number {
      return Number(db.value("SELECT COUNT(*) FROM outbox WHERE account_id = ? AND state = 'failed'", accountId) ?? 0);
    },

    /** Failed ops get another round (on "Sync now" and after a reconnect). */
    retryFailed(accountId: string): number {
      return db.run(
        "UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = 0 WHERE account_id = ? AND state = 'failed'",
        accountId,
      ).changes;
    },

    /** Ops waiting for a retry become due now (the connection is back). */
    makeDueNow(accountId: string): void {
      db.run("UPDATE outbox SET next_attempt_at = 0 WHERE account_id = ? AND state = 'pending'", accountId);
    },

    /** uid → message id of the known messages in a mailbox. */
    uidMap(mailboxId: string): Map<number, string> {
      const out = new Map<number, string>();
      for (const row of db.all<{ uid: number; message_id: string }>(
        "SELECT uid, message_id FROM message_mailboxes WHERE mailbox_id = ? AND uid IS NOT NULL",
        mailboxId,
      )) {
        out.set(row.uid, row.message_id);
      }
      return out;
    },

    /** The newest known uids of a mailbox (for flag checks on servers without CONDSTORE). */
    newestUids(mailboxId: string, limit: number): number[] {
      return db
        .all<{ uid: number }>(
          "SELECT uid FROM message_mailboxes WHERE mailbox_id = ? AND uid IS NOT NULL ORDER BY uid DESC LIMIT ?",
          mailboxId,
          limit,
        )
        .map((r) => r.uid);
    },

    /** UIDVALIDITY changed: the uids mean nothing now. */
    clearUids(mailboxId: string): void {
      db.run("UPDATE message_mailboxes SET uid = NULL WHERE mailbox_id = ?", mailboxId);
    },

    /** After a resync, locations that were not found again are gone. Returns their messages. */
    dropLocationsWithoutUid(mailboxId: string): string[] {
      const ids = db
        .all<{ message_id: string }>("SELECT message_id FROM message_mailboxes WHERE mailbox_id = ? AND uid IS NULL", mailboxId)
        .map((r) => r.message_id);
      db.run("DELETE FROM message_mailboxes WHERE mailbox_id = ? AND uid IS NULL", mailboxId);
      return ids;
    },

    /** Messages of the account that are nowhere on the server any more. */
    orphans(accountId: string): { id: string; threadId: string }[] {
      return db.all<{ id: string; threadId: string }>(
        `SELECT m.id AS id, m.thread_id AS threadId FROM messages m
          WHERE m.account_id = ? AND NOT EXISTS (SELECT 1 FROM message_mailboxes mm WHERE mm.message_id = m.id)`,
        accountId,
      );
    },

    threadIndexRows(accountId: string): IndexRow[] {
      return db.all<IndexRow>(
        `SELECT thread_id, message_id_header, in_reply_to, references_json, subject, date, from_json, to_json, cc_json
           FROM messages WHERE account_id = ? ORDER BY date`,
        accountId,
      );
    },

    /** Moves every message (and draft) of the `from` threads into `to`. */
    mergeThreads(accountId: string, from: string[], to: string): void {
      if (from.length === 0) return;
      db.run(
        `UPDATE messages SET thread_id = ? WHERE account_id = ? AND thread_id IN (${placeholders(from.length)})`,
        to,
        accountId,
        ...from,
      );
      db.run(
        `UPDATE drafts SET thread_id = ? WHERE account_id = ? AND thread_id IN (${placeholders(from.length)})`,
        to,
        accountId,
        ...from,
      );
    },

    threadForGmailThread(accountId: string, gmThreadId: string): string | null {
      return (
        db.value<string>(
          "SELECT thread_id FROM messages WHERE account_id = ? AND gm_thread_id = ? ORDER BY seq LIMIT 1",
          accountId,
          gmThreadId,
        ) ?? null
      );
    },

    /**
     * A message this app created itself (a sent message) that the server has not matched yet:
     * its remote id is still its Message-ID.
     */
    localByMessageId(accountId: string, header: string): string | null {
      return (
        db.value<string>(
          "SELECT id FROM messages WHERE account_id = ? AND message_id_header = ? AND remote_id = message_id_header ORDER BY seq LIMIT 1",
          accountId,
          header,
        ) ?? null
      );
    },

    /** The newest messages of an account whose bodies are not here yet. */
    newestWithoutBody(accountId: string, limit: number): string[] {
      return db
        .all<{ id: string }>(
          "SELECT id FROM messages WHERE account_id = ? AND body_state = 'none' ORDER BY date DESC LIMIT ?",
          accountId,
          limit,
        )
        .map((r) => r.id);
    },

    /** Label ids of each message. */
    labelIdsOf(messageIds: string[]): Map<string, Set<string>> {
      const out = new Map<string, Set<string>>();
      for (const row of store.messages.labels(messageIds)) {
        let set = out.get(row.messageId);
        if (!set) out.set(row.messageId, (set = new Set()));
        set.add(row.labelId);
      }
      return out;
    },

    /** The label with this name (case-insensitive), created when there is none. */
    labelByName(name: string, now: number): { label: LabelRecord; created: boolean } {
      const clean = name.replace(/\s+/g, " ").trim();
      const found = store.labels.findByName(clean);
      if (found) return { label: found, created: false };
      const label: LabelRecord = { id: newId("lbl"), name: clean, color: null, sortOrder: store.labels.nextSortOrder(), createdAt: now };
      store.labels.insert(label);
      return { label, created: true };
    },

    attachmentsWithoutFile(messageIds: string[]): { id: string; messageId: string }[] {
      if (messageIds.length === 0) return [];
      return chunked(messageIds, 500, (slice) =>
        db.all<{ id: string; messageId: string }>(
          `SELECT id, message_id AS messageId FROM attachments WHERE message_id IN (${placeholders(slice.length)}) AND local_path IS NULL`,
          ...slice,
        ),
      );
    },

    deleteAttachmentsOf(messageId: string): void {
      db.run("DELETE FROM attachments WHERE message_id = ?", messageId);
    },
  };
  return self;
}

export type SyncStore = ReturnType<typeof createSyncStore>;
