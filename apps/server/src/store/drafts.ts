import type { Actor, Address, Draft, DraftAttachment, DraftMode, DraftSendState } from "@fancy-mail/contracts";

import { parseJson } from "../db/sqlite.ts";
import type { Db } from "../db/sqlite.ts";
import type { DraftRecord, UploadRecord } from "./types.ts";

interface DraftRow {
  id: string;
  account_id: string;
  mode: string;
  thread_id: string;
  source_message_id: string | null;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  subject: string;
  body_text: string;
  attachments_json: string;
  created_by_json: string;
  created_at: number;
  updated_at: number;
  send_state: string;
  send_error: string | null;
  remote_uid: number | null;
  remote_mailbox_id: string | null;
}

function toRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    mode: row.mode as DraftMode,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    to: parseJson<Address[]>(row.to_json, []),
    cc: parseJson<Address[]>(row.cc_json, []),
    bcc: parseJson<Address[]>(row.bcc_json, []),
    subject: row.subject,
    bodyText: row.body_text,
    attachments: parseJson<DraftAttachment[]>(row.attachments_json, []),
    createdBy: parseJson<Actor>(row.created_by_json, { kind: "user" }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sendState: row.send_state as DraftSendState,
    sendError: row.send_error,
    remoteUid: row.remote_uid,
    remoteMailboxId: row.remote_mailbox_id,
  };
}

/** The contract Draft. A new message's own thread is not "a conversation it answers": null. */
export function toContractDraft(d: DraftRecord): Draft {
  return {
    id: d.id,
    accountId: d.accountId,
    mode: d.mode,
    threadId: d.mode === "new" ? null : d.threadId,
    sourceMessageId: d.sourceMessageId,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    bodyText: d.bodyText,
    attachments: d.attachments,
    createdBy: d.createdBy,
    updatedAt: d.updatedAt,
    sendState: d.sendState,
    sendError: d.sendError,
  };
}

export function createDraftsStore(db: Db) {
  return {
    get(id: string): DraftRecord | null {
      const row = db.get<DraftRow>("SELECT * FROM drafts WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },

    /** Unsent drafts, newest first. */
    list(accountIds: string[] | null = null): DraftRecord[] {
      const rows = db.all<DraftRow>("SELECT * FROM drafts WHERE send_state != 'sent' ORDER BY updated_at DESC");
      const allowed = accountIds ? new Set(accountIds) : null;
      return rows.map(toRecord).filter((d) => !allowed || allowed.has(d.accountId));
    },

    forThread(threadId: string): DraftRecord[] {
      return db
        .all<DraftRow>("SELECT * FROM drafts WHERE thread_id = ? AND send_state != 'sent' ORDER BY updated_at", threadId)
        .map(toRecord);
    },

    upsert(d: DraftRecord): void {
      db.run(
        `INSERT INTO drafts (id, account_id, mode, thread_id, source_message_id, to_json, cc_json, bcc_json, subject,
           body_text, attachments_json, created_by_json, created_at, updated_at, send_state, send_error, remote_uid,
           remote_mailbox_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id, mode = excluded.mode, thread_id = excluded.thread_id,
           source_message_id = excluded.source_message_id, to_json = excluded.to_json, cc_json = excluded.cc_json,
           bcc_json = excluded.bcc_json, subject = excluded.subject, body_text = excluded.body_text,
           attachments_json = excluded.attachments_json, updated_at = excluded.updated_at,
           send_state = excluded.send_state, send_error = excluded.send_error, remote_uid = excluded.remote_uid,
           remote_mailbox_id = excluded.remote_mailbox_id`,
        d.id,
        d.accountId,
        d.mode,
        d.threadId,
        d.sourceMessageId,
        JSON.stringify(d.to),
        JSON.stringify(d.cc),
        JSON.stringify(d.bcc),
        d.subject,
        d.bodyText,
        JSON.stringify(d.attachments),
        JSON.stringify(d.createdBy),
        d.createdAt,
        d.updatedAt,
        d.sendState,
        d.sendError,
        d.remoteUid,
        d.remoteMailboxId,
      );
    },

    setSendState(id: string, state: DraftSendState, error: string | null = null): void {
      db.run("UPDATE drafts SET send_state = ?, send_error = ? WHERE id = ?", state, error, id);
    },

    setRemote(id: string, remoteUid: number | null, remoteMailboxId: string | null): void {
      db.run("UPDATE drafts SET remote_uid = ?, remote_mailbox_id = ? WHERE id = ?", remoteUid, remoteMailboxId, id);
    },

    delete(id: string): void {
      db.run("DELETE FROM drafts WHERE id = ?", id);
    },

    /** Upload ids still used by some unsent draft. */
    referencedUploadIds(): Set<string> {
      const ids = new Set<string>();
      for (const row of db.all<{ attachments_json: string }>("SELECT attachments_json FROM drafts")) {
        for (const a of parseJson<DraftAttachment[]>(row.attachments_json, [])) ids.add(a.id);
      }
      return ids;
    },
  };
}

export type DraftsStore = ReturnType<typeof createDraftsStore>;

interface UploadRow {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  path: string;
  created_at: number;
}

function toUpload(row: UploadRow): UploadRecord {
  return { id: row.id, filename: row.filename, mimeType: row.mime_type, size: row.size, path: row.path, createdAt: row.created_at };
}

export function createUploadsStore(db: Db) {
  return {
    get(id: string): UploadRecord | null {
      const row = db.get<UploadRow>("SELECT * FROM uploads WHERE id = ?", id);
      return row ? toUpload(row) : null;
    },
    insert(u: UploadRecord): void {
      db.run(
        "INSERT INTO uploads (id, filename, mime_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        u.id,
        u.filename,
        u.mimeType,
        u.size,
        u.path,
        u.createdAt,
      );
    },
    olderThan(at: number): UploadRecord[] {
      return db.all<UploadRow>("SELECT * FROM uploads WHERE created_at < ?", at).map(toUpload);
    },
    delete(id: string): void {
      db.run("DELETE FROM uploads WHERE id = ?", id);
    },
  };
}

export type UploadsStore = ReturnType<typeof createUploadsStore>;
