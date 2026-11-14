/**
 * The schema, as ordered migrations keyed by PRAGMA user_version. Never edit a migration that
 * has shipped; add the next one.
 *
 * Overview
 *   accounts ─┬─ mailboxes ── message_mailboxes ─┐
 *             ├─ messages ──┬────────────────────┘ (a message can sit in several mailboxes)
 *             │             ├─ message_labels ── labels (global, mirrored to every server)
 *             │             ├─ message_bodies, attachments, message_fts (FTS5, rowid = seq)
 *             ├─ threads (denormalized cache) ── thread_labels, thread_summaries
 *             ├─ drafts, outbox
 *   groups, settings, kv, secrets (AES-GCM), uploads, activity (with its inverse for Undo)
 */
import type { Db } from "./sqlite.ts";

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const THREAD_ORDER = "last_message_at DESC, id DESC";

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

        CREATE TABLE groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT NOT NULL,
          sort_order REAL NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          username TEXT NOT NULL,
          provider TEXT NOT NULL,
          auth_kind TEXT NOT NULL,
          group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
          color TEXT NOT NULL,
          sort_order REAL NOT NULL DEFAULT 0,
          agent_access TEXT NOT NULL DEFAULT 'read',
          signature TEXT NOT NULL DEFAULT '',
          imap_json TEXT,
          smtp_json TEXT,
          status_json TEXT NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0,
          is_demo INTEGER NOT NULL DEFAULT 0,
          sync_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX accounts_email ON accounts(lower(email));
        CREATE INDEX accounts_group ON accounts(group_id, sort_order);

        CREATE TABLE labels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          color TEXT,
          sort_order REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX labels_name ON labels(lower(name));

        CREATE TABLE mailboxes (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT,
          delimiter TEXT,
          special_use TEXT,
          uidvalidity INTEGER,
          uidnext INTEGER,
          highestmodseq TEXT,
          sync_json TEXT,
          selectable INTEGER NOT NULL DEFAULT 1,
          created_locally INTEGER NOT NULL DEFAULT 0,
          UNIQUE (account_id, path)
        );
        CREATE INDEX mailboxes_role ON mailboxes(account_id, role);

        CREATE TABLE messages (
          seq INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL,
          remote_id TEXT,
          gm_thread_id TEXT,
          message_id_header TEXT,
          in_reply_to TEXT,
          references_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          from_json TEXT,
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          reply_to_json TEXT NOT NULL DEFAULT '[]',
          date INTEGER NOT NULL,
          snippet TEXT NOT NULL DEFAULT '',
          size INTEGER NOT NULL DEFAULT 0,
          unread INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          is_draft INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          body_state TEXT NOT NULL DEFAULT 'none',
          body_error TEXT,
          body_attempts INTEGER NOT NULL DEFAULT 0,
          restore_json TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX messages_thread ON messages(thread_id, date);
        CREATE INDEX messages_account_date ON messages(account_id, date DESC);
        CREATE INDEX messages_remote ON messages(account_id, remote_id);
        CREATE INDEX messages_msgid ON messages(account_id, message_id_header);
        CREATE INDEX messages_gm_thread ON messages(account_id, gm_thread_id) WHERE gm_thread_id IS NOT NULL;

        CREATE TABLE message_mailboxes (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
          uid INTEGER,
          PRIMARY KEY (message_id, mailbox_id)
        ) WITHOUT ROWID;
        CREATE INDEX message_mailboxes_uid ON message_mailboxes(mailbox_id, uid);

        CREATE TABLE message_labels (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
          PRIMARY KEY (message_id, label_id)
        ) WITHOUT ROWID;
        CREATE INDEX message_labels_label ON message_labels(label_id);

        CREATE TABLE message_bodies (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          text TEXT,
          html TEXT,
          fetched_at INTEGER NOT NULL
        ) WITHOUT ROWID;

        CREATE VIRTUAL TABLE message_fts USING fts5(
          subject, sender, recipients, cc, body, attachments,
          content = '', contentless_delete = 1, prefix = '2 3',
          tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
          DELETE FROM message_fts WHERE rowid = old.seq;
        END;

        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          part TEXT,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          content_id TEXT,
          inline INTEGER NOT NULL DEFAULT 0,
          local_path TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX attachments_message ON attachments(message_id, sort_order);

        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          subject TEXT NOT NULL DEFAULT '',
          snippet TEXT NOT NULL DEFAULT '',
          participants_json TEXT NOT NULL DEFAULT '[]',
          last_message_at INTEGER NOT NULL,
          first_message_at INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          live_count INTEGER NOT NULL DEFAULT 0,
          unread_count INTEGER NOT NULL DEFAULT 0,
          starred INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          in_inbox INTEGER NOT NULL DEFAULT 0,
          in_sent INTEGER NOT NULL DEFAULT 0,
          in_drafts INTEGER NOT NULL DEFAULT 0,
          in_trash INTEGER NOT NULL DEFAULT 0,
          in_spam INTEGER NOT NULL DEFAULT 0,
          in_archive INTEGER NOT NULL DEFAULT 0,
          draft_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX threads_recent ON threads(${THREAD_ORDER});
        CREATE INDEX threads_account ON threads(account_id, ${THREAD_ORDER});
        CREATE INDEX threads_inbox ON threads(${THREAD_ORDER}) WHERE in_inbox = 1;
        CREATE INDEX threads_account_inbox ON threads(account_id, ${THREAD_ORDER}) WHERE in_inbox = 1;
        CREATE INDEX threads_sent ON threads(${THREAD_ORDER}) WHERE in_sent = 1;
        CREATE INDEX threads_trash ON threads(${THREAD_ORDER}) WHERE in_trash = 1;
        CREATE INDEX threads_spam ON threads(${THREAD_ORDER}) WHERE in_spam = 1;
        CREATE INDEX threads_archive ON threads(${THREAD_ORDER}) WHERE in_archive = 1;
        CREATE INDEX threads_starred ON threads(${THREAD_ORDER}) WHERE starred = 1;
        CREATE INDEX threads_unread ON threads(${THREAD_ORDER}) WHERE unread_count > 0;
        CREATE INDEX threads_attachments ON threads(${THREAD_ORDER}) WHERE has_attachments = 1;

        CREATE TABLE thread_labels (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
          PRIMARY KEY (thread_id, label_id)
        ) WITHOUT ROWID;
        CREATE INDEX thread_labels_label ON thread_labels(label_id, thread_id);

        CREATE TABLE drafts (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          body_text TEXT NOT NULL DEFAULT '',
          attachments_json TEXT NOT NULL DEFAULT '[]',
          created_by_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          send_state TEXT NOT NULL DEFAULT 'draft',
          send_error TEXT,
          remote_uid INTEGER,
          remote_mailbox_id TEXT
        );
        CREATE INDEX drafts_thread ON drafts(thread_id);
        CREATE INDEX drafts_updated ON drafts(updated_at DESC);

        CREATE TABLE uploads (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE activity (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          actor_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          kind TEXT NOT NULL,
          thread_ids_json TEXT NOT NULL DEFAULT '[]',
          account_ids_json TEXT NOT NULL DEFAULT '[]',
          undo_json TEXT,
          undone_at INTEGER,
          undone_by_json TEXT,
          is_demo INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX activity_at ON activity(at DESC, id DESC);

        CREATE TABLE outbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX outbox_account ON outbox(account_id, state, seq);

        CREATE TABLE secrets (
          account_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          ciphertext BLOB NOT NULL,
          iv BLOB NOT NULL,
          tag BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, kind)
        ) WITHOUT ROWID;
      `);
    },
  },
  {
    version: 2,
    name: "fast unread counts per mailbox",
    up: (db) => {
      db.exec("CREATE INDEX messages_unread ON messages(id) WHERE unread = 1");
    },
  },
  {
    version: 3,
    name: "Gmail inbox categories",
    up: (db) => {
      // messages.category: what Gmail says for a message in the inbox (null: not Gmail, or not
      // asked yet). threads.category: the newest categorized message's, for the inbox tabs.
      db.exec(`
        ALTER TABLE messages ADD COLUMN category TEXT;
        ALTER TABLE threads ADD COLUMN category TEXT;
      `);
    },
  },
  {
    version: 4,
    name: "sender name apart from the name shown in the app",
    up: (db) => {
      // display_name is now only the account's name inside the app; sender_name goes into the
      // From line. Until now one name did both, so existing accounts start with it in both.
      db.exec(`
        ALTER TABLE accounts ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
        UPDATE accounts SET sender_name = display_name;
      `);
    },
  },
  {
    version: 5,
    name: "waiting and snoozed conversations",
    up: (db) => {
      // The states are labels (Waiting, Snoozed…); these keep when they end and why a
      // conversation came back. drafts.wait_until: "Send and wait" sets Waiting once it's sent.
      db.exec(`
        CREATE TABLE thread_timers (
          thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          until INTEGER NOT NULL,
          set_at INTEGER NOT NULL
        );
        CREATE INDEX thread_timers_until ON thread_timers(until);
        CREATE TABLE thread_marks (
          thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        ALTER TABLE drafts ADD COLUMN wait_until INTEGER;
      `);
    },
  },
  {
    version: 6,
    name: "summaries agents write on conversations",
    up: (db) => {
      // One per conversation, shown above its messages. by_json: who wrote it (an Actor).
      db.exec(`
        CREATE TABLE thread_summaries (
          thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          by_json TEXT NOT NULL,
          at INTEGER NOT NULL
        );
      `);
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface MigrateResult {
  /** The database was empty before (first run): the caller may seed demo data. */
  fresh: boolean;
  from: number;
  to: number;
}

export function migrate(db: Db): MigrateResult {
  const from = Number(db.value("PRAGMA user_version") ?? 0);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `The mail database was made by a newer Fancy Mail (schema ${from}, this build knows ${SCHEMA_VERSION}). Update Fancy Mail to open it.`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.tx(() => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return { fresh: from === 0, from, to: SCHEMA_VERSION };
}
