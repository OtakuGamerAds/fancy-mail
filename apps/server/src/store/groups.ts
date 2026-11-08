import { bool } from "../db/sqlite.ts";
import type { Db, SqlValue } from "../db/sqlite.ts";
import type { GroupRecord } from "./types.ts";

interface GroupRow {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  collapsed: number;
  created_at: number;
}

function toRecord(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    collapsed: row.collapsed === 1,
    createdAt: row.created_at,
  };
}

export type GroupPatch = Partial<Pick<GroupRecord, "name" | "color" | "sortOrder" | "collapsed">>;

export function createGroupsStore(db: Db) {
  return {
    list(): GroupRecord[] {
      return db.all<GroupRow>("SELECT * FROM groups ORDER BY sort_order, created_at").map(toRecord);
    },

    get(id: string): GroupRecord | null {
      const row = db.get<GroupRow>("SELECT * FROM groups WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },

    insert(group: GroupRecord): void {
      db.run(
        "INSERT INTO groups (id, name, color, sort_order, collapsed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        group.id,
        group.name,
        group.color,
        group.sortOrder,
        bool(group.collapsed),
        group.createdAt,
      );
    },

    update(id: string, patch: GroupPatch): void {
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.name !== undefined) (sets.push("name = ?"), params.push(patch.name));
      if (patch.color !== undefined) (sets.push("color = ?"), params.push(patch.color));
      if (patch.sortOrder !== undefined) (sets.push("sort_order = ?"), params.push(patch.sortOrder));
      if (patch.collapsed !== undefined) (sets.push("collapsed = ?"), params.push(bool(patch.collapsed)));
      if (sets.length === 0) return;
      db.run(`UPDATE groups SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
    },

    delete(id: string): void {
      db.run("DELETE FROM groups WHERE id = ?", id);
    },

    nextSortOrder(): number {
      return (db.value<number | null>("SELECT MAX(sort_order) FROM groups") ?? -1) + 1;
    },

    accountIds(groupId: string): string[] {
      return db
        .all<{ id: string }>("SELECT id FROM accounts WHERE group_id = ? ORDER BY sort_order", groupId)
        .map((r) => r.id);
    },
  };
}

export type GroupsStore = ReturnType<typeof createGroupsStore>;
