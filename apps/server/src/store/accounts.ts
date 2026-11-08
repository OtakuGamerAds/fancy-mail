import type { AccountStatus, AgentAccess, AuthKind, Provider, ServerEndpoint } from "@fancy-mail/contracts";

import { bool, parseJson } from "../db/sqlite.ts";
import type { Db, SqlValue } from "../db/sqlite.ts";
import type { AccountPatch, AccountRecord, NewAccount } from "./types.ts";

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  username: string;
  provider: string;
  auth_kind: string;
  group_id: string | null;
  color: string;
  sort_order: number;
  agent_access: string;
  signature: string;
  imap_json: string | null;
  smtp_json: string | null;
  status_json: string;
  paused: number;
  is_demo: number;
  created_at: number;
}

const DEFAULT_STATUS: AccountStatus = { state: "idle", message: null, lastSyncAt: null, progress: null };

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    username: row.username,
    provider: row.provider as Provider,
    authKind: row.auth_kind as AuthKind,
    groupId: row.group_id,
    color: row.color,
    sortOrder: row.sort_order,
    agentAccess: row.agent_access as AgentAccess,
    signature: row.signature,
    imap: parseJson<ServerEndpoint | null>(row.imap_json, null),
    smtp: parseJson<ServerEndpoint | null>(row.smtp_json, null),
    status: parseJson<AccountStatus>(row.status_json, DEFAULT_STATUS),
    paused: row.paused === 1,
    isDemo: row.is_demo === 1,
    createdAt: row.created_at,
  };
}

const COLUMNS: Record<keyof AccountPatch, string> = {
  email: "email",
  displayName: "display_name",
  username: "username",
  provider: "provider",
  authKind: "auth_kind",
  groupId: "group_id",
  color: "color",
  sortOrder: "sort_order",
  agentAccess: "agent_access",
  signature: "signature",
  imap: "imap_json",
  smtp: "smtp_json",
  paused: "paused",
};

function columnValue(key: keyof AccountPatch, value: unknown): SqlValue {
  if (key === "imap" || key === "smtp") return value === null || value === undefined ? null : JSON.stringify(value);
  if (key === "paused") return bool(Boolean(value));
  return value as SqlValue;
}

export function createAccountsStore(db: Db) {
  return {
    list(): AccountRecord[] {
      return db.all<AccountRow>("SELECT * FROM accounts ORDER BY sort_order, created_at").map(toRecord);
    },

    get(id: string): AccountRecord | null {
      const row = db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },

    findByEmail(email: string): AccountRecord | null {
      const row = db.get<AccountRow>("SELECT * FROM accounts WHERE lower(email) = lower(?)", email.trim());
      return row ? toRecord(row) : null;
    },

    insert(account: NewAccount): void {
      db.run(
        `INSERT INTO accounts (id, email, display_name, username, provider, auth_kind, group_id, color, sort_order,
           agent_access, signature, imap_json, smtp_json, status_json, paused, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        account.id,
        account.email,
        account.displayName,
        account.username,
        account.provider,
        account.authKind,
        account.groupId,
        account.color,
        account.sortOrder,
        account.agentAccess,
        account.signature,
        account.imap ? JSON.stringify(account.imap) : null,
        account.smtp ? JSON.stringify(account.smtp) : null,
        JSON.stringify(account.status),
        bool(account.paused),
        bool(account.isDemo),
        account.createdAt,
      );
    },

    update(id: string, patch: AccountPatch): void {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      for (const key of Object.keys(patch) as (keyof AccountPatch)[]) {
        if (patch[key] === undefined) continue;
        sets.push(`${COLUMNS[key]} = ?`);
        params.push(columnValue(key, patch[key]));
      }
      if (sets.length === 0) return;
      db.run(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    },

    setStatus(id: string, status: AccountStatus): void {
      db.run("UPDATE accounts SET status_json = ? WHERE id = ?", JSON.stringify(status), id);
    },

    delete(id: string): void {
      db.run("DELETE FROM accounts WHERE id = ?", id);
    },

    /** The sort order for an account appended at the end of a group (or of the ungrouped ones). */
    nextSortOrder(groupId: string | null): number {
      const max = db.value<number | null>(
        "SELECT MAX(sort_order) FROM accounts WHERE group_id IS ?",
        groupId,
      );
      return (max ?? -1) + 1;
    },

    count(): number {
      return Number(db.value("SELECT COUNT(*) FROM accounts") ?? 0);
    },

    demoIds(): string[] {
      return db.all<{ id: string }>("SELECT id FROM accounts WHERE is_demo = 1").map((r) => r.id);
    },

    isDemo(id: string): boolean {
      return db.value<number>("SELECT is_demo FROM accounts WHERE id = ?", id) === 1;
    },

    /** Unread conversations in each account's inbox. */
    unreadInboxCounts(): Map<string, number> {
      const rows = db.all<{ account_id: string; n: number }>(
        "SELECT account_id, COUNT(*) AS n FROM threads WHERE in_inbox = 1 AND unread_count > 0 GROUP BY account_id",
      );
      return new Map(rows.map((r) => [r.account_id, r.n]));
    },

    /** The sync engine's own per-account state (capabilities, last pass, …). */
    getSyncState(id: string): Record<string, unknown> | null {
      return parseJson<Record<string, unknown> | null>(db.value("SELECT sync_json FROM accounts WHERE id = ?", id), null);
    },

    setSyncState(id: string, state: Record<string, unknown> | null): void {
      db.run("UPDATE accounts SET sync_json = ? WHERE id = ?", state ? JSON.stringify(state) : null, id);
    },
  };
}

export type AccountsStore = ReturnType<typeof createAccountsStore>;
