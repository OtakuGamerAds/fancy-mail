import { chunked, placeholders } from "../db/sqlite.ts";
import type { Db, SqlValue } from "../db/sqlite.ts";
import type { LabelRecord } from "./types.ts";

interface LabelRow {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
  created_at: number;
}

function toRecord(row: LabelRow): LabelRecord {
  return { id: row.id, name: row.name, color: row.color, sortOrder: row.sort_order, createdAt: row.created_at };
}

export type LabelPatch = Partial<Pick<LabelRecord, "name" | "color" | "sortOrder">>;

export interface LabelCounts {
  threads: number;
  unread: number;
  byAccount: Record<string, { threads: number; unread: number }>;
}

export function createLabelsStore(db: Db) {
  return {
    list(): LabelRecord[] {
      return db.all<LabelRow>("SELECT * FROM labels ORDER BY sort_order, name").map(toRecord);
    },

    get(id: string): LabelRecord | null {
      const row = db.get<LabelRow>("SELECT * FROM labels WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },

    /** Case-insensitive, Unicode-aware (SQLite's lower() only folds ASCII). */
    findByName(name: string): LabelRecord | null {
      const wanted = name.trim().toLocaleLowerCase();
      const rows = db.all<LabelRow>("SELECT * FROM labels");
      const row = rows.find((l) => l.name.toLocaleLowerCase() === wanted);
      return row ? toRecord(row) : null;
    },

    insert(label: LabelRecord): void {
      db.run(
        "INSERT INTO labels (id, name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)",
        label.id,
        label.name,
        label.color,
        label.sortOrder,
        label.createdAt,
      );
    },

    update(id: string, patch: LabelPatch): void {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.name !== undefined) (sets.push("name = ?"), params.push(patch.name));
      if (patch.color !== undefined) (sets.push("color = ?"), params.push(patch.color));
      if (patch.sortOrder !== undefined) (sets.push("sort_order = ?"), params.push(patch.sortOrder));
      if (sets.length === 0) return;
      db.run(`UPDATE labels SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    },

    delete(id: string): void {
      db.run("DELETE FROM labels WHERE id = ?", id);
    },

    nextSortOrder(): number {
      return (db.value<number | null>("SELECT MAX(sort_order) FROM labels") ?? -1) + 1;
    },

    /**
     * Conversations carrying each label (outside trash and spam), and how many of them are
     * unread. `accountIds` limits the count to those accounts (agents see only theirs).
     */
    counts(accountIds: string[] | null = null): Map<string, LabelCounts> {
      const scope = accountIds ? `AND t.account_id IN (${placeholders(accountIds.length)})` : "";
      if (accountIds && accountIds.length === 0) return new Map();
      const rows = db.all<{ label_id: string; account_id: string; n: number; unread: number }>(
        `SELECT tl.label_id AS label_id, t.account_id AS account_id, COUNT(*) AS n, SUM(t.unread_count > 0) AS unread
           FROM thread_labels tl JOIN threads t ON t.id = tl.thread_id
          WHERE (t.live_count > 0 OR t.draft_count > 0) ${scope}
          GROUP BY tl.label_id, t.account_id`,
        ...((accountIds ?? []) as SqlValue[]),
      );
      const out = new Map<string, LabelCounts>();
      for (const r of rows) {
        const c = out.get(r.label_id) ?? { threads: 0, unread: 0, byAccount: {} };
        const unread = r.unread ?? 0;
        c.threads += r.n;
        c.unread += unread;
        c.byAccount[r.account_id] = { threads: r.n, unread };
        out.set(r.label_id, c);
      }
      return out;
    },

    /** The messages that carry a label (for undoing a delete), with their accounts. */
    messagesWithLabel(labelId: string): { messageId: string; accountId: string; threadId: string }[] {
      return db.all<{ messageId: string; accountId: string; threadId: string }>(
        `SELECT ml.message_id AS messageId, m.account_id AS accountId, m.thread_id AS threadId
           FROM message_labels ml JOIN messages m ON m.id = ml.message_id
          WHERE ml.label_id = ?`,
        labelId,
      );
    },

    /** Labels by id, for a set of ids (unknown ids are left out). */
    byIds(ids: string[]): LabelRecord[] {
      if (ids.length === 0) return [];
      return chunked(ids, 500, (slice) =>
        db.all<LabelRow>(`SELECT * FROM labels WHERE id IN (${placeholders(slice.length)})`, ...slice).map(toRecord),
      );
    },
  };
}

export type LabelsStore = ReturnType<typeof createLabelsStore>;
