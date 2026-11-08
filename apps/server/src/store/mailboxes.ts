import type { Mailbox, MailboxRole } from "@fancy-mail/contracts";

import { bool, parseJson } from "../db/sqlite.ts";
import type { Db, SqlValue } from "../db/sqlite.ts";
import type { MailboxRecord, NewMailbox } from "./types.ts";

interface MailboxRow {
  id: string;
  account_id: string;
  path: string;
  name: string;
  role: string | null;
  delimiter: string | null;
  special_use: string | null;
  uidvalidity: number | null;
  uidnext: number | null;
  highestmodseq: string | null;
  sync_json: string | null;
  selectable: number;
  created_locally: number;
}

function toRecord(row: MailboxRow): MailboxRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    path: row.path,
    name: row.name,
    role: (row.role as MailboxRole | null) ?? null,
    delimiter: row.delimiter,
    specialUse: row.special_use,
    uidvalidity: row.uidvalidity,
    uidnext: row.uidnext,
    highestmodseq: row.highestmodseq,
    sync: parseJson<Record<string, unknown> | null>(row.sync_json, null),
    selectable: row.selectable === 1,
    createdLocally: row.created_locally === 1,
  };
}

export type MailboxPatch = Partial<Omit<MailboxRecord, "id" | "accountId">>;

const COLUMNS: Record<keyof MailboxPatch, string> = {
  path: "path",
  name: "name",
  role: "role",
  delimiter: "delimiter",
  specialUse: "special_use",
  uidvalidity: "uidvalidity",
  uidnext: "uidnext",
  highestmodseq: "highestmodseq",
  sync: "sync_json",
  selectable: "selectable",
  createdLocally: "created_locally",
};

export function createMailboxesStore(db: Db) {
  return {
    list(accountId?: string): MailboxRecord[] {
      const rows = accountId
        ? db.all<MailboxRow>("SELECT * FROM mailboxes WHERE account_id = ? ORDER BY path", accountId)
        : db.all<MailboxRow>("SELECT * FROM mailboxes ORDER BY account_id, path");
      return rows.map(toRecord);
    },

    get(id: string): MailboxRecord | null {
      const row = db.get<MailboxRow>("SELECT * FROM mailboxes WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },

    byPath(accountId: string, path: string): MailboxRecord | null {
      const row = db.get<MailboxRow>("SELECT * FROM mailboxes WHERE account_id = ? AND path = ?", accountId, path);
      return row ? toRecord(row) : null;
    },

    /** The first mailbox with that role (an account has at most one per role in practice). */
    byRole(accountId: string, role: MailboxRole): MailboxRecord | null {
      const row = db.get<MailboxRow>(
        "SELECT * FROM mailboxes WHERE account_id = ? AND role = ? ORDER BY created_locally, path LIMIT 1",
        accountId,
        role,
      );
      return row ? toRecord(row) : null;
    },

    insert(mailbox: NewMailbox): void {
      db.run(
        `INSERT INTO mailboxes (id, account_id, path, name, role, delimiter, special_use, uidvalidity, uidnext,
           highestmodseq, sync_json, selectable, created_locally)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mailbox.id,
        mailbox.accountId,
        mailbox.path,
        mailbox.name,
        mailbox.role,
        mailbox.delimiter ?? null,
        mailbox.specialUse ?? null,
        mailbox.uidvalidity ?? null,
        mailbox.uidnext ?? null,
        mailbox.highestmodseq ?? null,
        mailbox.sync ? JSON.stringify(mailbox.sync) : null,
        bool(mailbox.selectable ?? true),
        bool(mailbox.createdLocally ?? false),
      );
    },

    update(id: string, patch: MailboxPatch): void {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      for (const key of Object.keys(patch) as (keyof MailboxPatch)[]) {
        const value = patch[key];
        if (value === undefined) continue;
        sets.push(`${COLUMNS[key]} = ?`);
        if (key === "sync") params.push(value ? JSON.stringify(value) : null);
        else if (key === "selectable" || key === "createdLocally") params.push(bool(Boolean(value)));
        else params.push(value as SqlValue);
      }
      if (sets.length === 0) return;
      db.run(`UPDATE mailboxes SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    },

    delete(id: string): void {
      db.run("DELETE FROM mailboxes WHERE id = ?", id);
    },

    /** Mailboxes as the client sees them, with message counts. */
    listWithCounts(accountIds: string[] | null = null): Mailbox[] {
      const counts = new Map<string, { total: number; unread: number }>();
      for (const row of db.all<{ mailbox_id: string; total: number }>(
        "SELECT mailbox_id, COUNT(*) AS total FROM message_mailboxes GROUP BY mailbox_id",
      )) {
        counts.set(row.mailbox_id, { total: row.total, unread: 0 });
      }
      // Unread messages are few: walk them (partial index) instead of every location.
      for (const row of db.all<{ mailbox_id: string; unread: number }>(
        `SELECT mm.mailbox_id AS mailbox_id, COUNT(*) AS unread
           FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id
          WHERE m.unread = 1 GROUP BY mm.mailbox_id`,
      )) {
        const c = counts.get(row.mailbox_id);
        if (c) c.unread = row.unread;
      }
      const allowed = accountIds ? new Set(accountIds) : null;
      return this.list()
        .filter((m) => !allowed || allowed.has(m.accountId))
        .map((m) => ({
          id: m.id,
          accountId: m.accountId,
          path: m.path,
          name: m.name,
          role: m.role,
          unreadCount: counts.get(m.id)?.unread ?? 0,
          totalCount: counts.get(m.id)?.total ?? 0,
        }));
    },
  };
}

export type MailboxesStore = ReturnType<typeof createMailboxesStore>;
