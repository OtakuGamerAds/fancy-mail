import { COLOR_PALETTE } from "@fancy-mail/contracts";
import type { Group } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import type { AccountRecord, GroupRecord } from "../store/types.ts";
import { canSee, requireAccess, requireAnyAccess } from "./context.ts";
import type { CallContext } from "./context.ts";
import { invalidate, writeActivity } from "./env.ts";
import type { ServiceEnv } from "./env.ts";
import { validColor } from "./labels.ts";

export type GroupUndo =
  | { type: "groupCreate"; groupId: string }
  | { type: "groupUpdate"; groupId: string; name: string; color: string }
  | { type: "groupDelete"; group: GroupRecord; accounts: { id: string; sortOrder: number }[] }
  | { type: "groupAssign"; accounts: { id: string; groupId: string | null; sortOrder: number }[] };

export function createGroupsService(env: ServiceEnv) {
  const { store } = env;

  function unreadByGroup(): Map<string, number> {
    const unread = store.accounts.unreadInboxCounts();
    const out = new Map<string, number>();
    for (const a of store.accounts.list()) {
      if (!a.groupId) continue;
      out.set(a.groupId, (out.get(a.groupId) ?? 0) + (unread.get(a.id) ?? 0));
    }
    return out;
  }

  function toGroup(g: GroupRecord, unread: Map<string, number>): Group {
    return { id: g.id, name: g.name, color: g.color, sortOrder: g.sortOrder, collapsed: g.collapsed, unreadInboxCount: unread.get(g.id) ?? 0 };
  }

  function requireGroup(id: string): GroupRecord {
    const group = store.groups.get(id);
    if (!group) throw new AppError("not_found", `No group with id ${id}. It may have been deleted.`);
    return group;
  }

  function cleanName(name: string, exceptId?: string): string {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean) throw new AppError("bad_request", "A group needs a name.");
    if (clean.length > 60) throw new AppError("bad_request", "Group names can be at most 60 characters.");
    if (clean.toLowerCase() === "none") throw new AppError("bad_request", `"none" is reserved by search (group:none). Pick another name.`);
    const clash = store.groups.list().find((g) => g.id !== exceptId && g.name.toLocaleLowerCase() === clean.toLocaleLowerCase());
    if (clash) throw new AppError("conflict", `There's already a group named "${clean}".`);
    return clean;
  }

  function publish(activity: ReturnType<typeof writeActivity> | null): void {
    invalidate(env, activity ? ["groups", "accounts", "activity"] : ["groups", "accounts"]);
    if (activity) env.bus.publish({ type: "activity", activity });
  }

  const service = {
    list(): Group[] {
      const unread = unreadByGroup();
      return store.groups.list().map((g) => toGroup(g, unread));
    },

    get(id: string): Group {
      return toGroup(requireGroup(id), unreadByGroup());
    },

    resolve(nameOrId: string): Group | null {
      const wanted = nameOrId.trim();
      const record =
        store.groups.get(wanted) ?? store.groups.list().find((g) => g.name.toLocaleLowerCase() === wanted.toLocaleLowerCase()) ?? null;
      return record ? toGroup(record, unreadByGroup()) : null;
    },

    create(input: { name: string; color?: string }, ctx: CallContext): Group {
      requireAnyAccess(ctx, store.accounts.list(), "organize", "Creating groups");
      const name = cleanName(input.name);
      const used = new Set(store.groups.list().map((g) => g.color));
      const color = validColor(input.color, "The group") ?? COLOR_PALETTE.find((c) => !used.has(c)) ?? COLOR_PALETTE[0];
      const record: GroupRecord = { id: newId("grp"), name, color, sortOrder: store.groups.nextSortOrder(), collapsed: false, createdAt: env.now() };
      const activity = env.db.tx(() => {
        store.groups.insert(record);
        return writeActivity(env, {
          actor: ctx.actor,
          summary: `Created the group ${name}`,
          kind: "group",
          undo: { type: "groupCreate", groupId: record.id } satisfies GroupUndo,
        });
      });
      publish(activity);
      return toGroup(record, new Map());
    },

    update(input: { groupId: string; name?: string; color?: string; collapsed?: boolean }, ctx: CallContext): Group {
      const before = requireGroup(input.groupId);
      const name = input.name !== undefined ? cleanName(input.name, before.id) : undefined;
      const color = validColor(input.color, "The group") ?? undefined;
      const changesLook = (name !== undefined && name !== before.name) || (color !== undefined && color !== before.color);
      if (changesLook) requireAnyAccess(ctx, store.accounts.list(), "organize", "Changing groups");
      let activity: ReturnType<typeof writeActivity> | null = null;
      env.db.tx(() => {
        store.groups.update(before.id, { name, color, collapsed: input.collapsed });
        if (changesLook) {
          activity = writeActivity(env, {
            actor: ctx.actor,
            summary: name !== undefined && name !== before.name ? `Renamed the group ${before.name} to ${name}` : `Changed the color of ${before.name}`,
            kind: "group",
            undo: { type: "groupUpdate", groupId: before.id, name: before.name, color: before.color } satisfies GroupUndo,
          });
        }
      });
      publish(activity);
      return service.get(before.id);
    },

    delete(input: { groupId: string }, ctx: CallContext): void {
      const group = requireGroup(input.groupId);
      const accounts = store.accounts.list().filter((a) => a.groupId === group.id);
      requireAnyAccess(ctx, store.accounts.list(), "organize", "Deleting groups");
      for (const a of accounts) requireAccess(ctx, a, "organize", `moving ${a.email} out of the group`);
      const activity = env.db.tx(() => {
        // Accounts stay; they become ungrouped (after the ones already ungrouped).
        let order = store.accounts.nextSortOrder(null);
        for (const a of accounts) store.accounts.update(a.id, { groupId: null, sortOrder: order++ });
        store.groups.delete(group.id);
        return writeActivity(env, {
          actor: ctx.actor,
          summary: `Deleted the group ${group.name}`,
          kind: "group",
          accountIds: accounts.map((a) => a.id),
          undo: { type: "groupDelete", group, accounts: accounts.map((a) => ({ id: a.id, sortOrder: a.sortOrder })) } satisfies GroupUndo,
        });
      });
      publish(activity);
    },

    reorder(input: { groupIds: string[] }, ctx: CallContext): void {
      requireAnyAccess(ctx, store.accounts.list(), "organize", "Reordering groups");
      env.db.tx(() => {
        const known = new Set(store.groups.list().map((g) => g.id));
        let order = 0;
        for (const id of input.groupIds) if (known.has(id)) store.groups.update(id, { sortOrder: order++ });
        for (const g of store.groups.list()) if (!input.groupIds.includes(g.id)) store.groups.update(g.id, { sortOrder: order++ });
      });
      publish(null);
    },

    /** Moves accounts into a group (null: ungrouped), appended in the order given. */
    assignAccounts(input: { accountIds: string[]; groupId: string | null }, ctx: CallContext): void {
      const group = input.groupId ? requireGroup(input.groupId) : null;
      const accounts: AccountRecord[] = input.accountIds.map((id) => {
        const a = store.accounts.get(id);
        if (!a || !canSee(ctx, a)) throw new AppError("not_found", `No account with id ${id}.`);
        return a;
      });
      for (const a of accounts) requireAccess(ctx, a, "organize", `moving ${a.email} to another group`);
      const moving = accounts.filter((a) => a.groupId !== (group?.id ?? null));
      if (moving.length === 0) return;
      const activity = env.db.tx(() => {
        let order = store.accounts.nextSortOrder(group?.id ?? null);
        for (const a of moving) store.accounts.update(a.id, { groupId: group?.id ?? null, sortOrder: order++ });
        const who = moving.length === 1 ? moving[0]!.email : `${moving.length} accounts`;
        return writeActivity(env, {
          actor: ctx.actor,
          summary: group ? `Moved ${who} to ${group.name}` : `Moved ${who} out of their group`,
          kind: "group",
          accountIds: moving.map((a) => a.id),
          undo: { type: "groupAssign", accounts: moving.map((a) => ({ id: a.id, groupId: a.groupId, sortOrder: a.sortOrder })) } satisfies GroupUndo,
        });
      });
      publish(activity);
    },

    undo(undo: GroupUndo): void {
      env.db.tx(() => {
        switch (undo.type) {
          case "groupCreate": {
            const group = store.groups.get(undo.groupId);
            if (!group) throw new AppError("conflict", "Nothing to undo: that group was deleted since.");
            let order = store.accounts.nextSortOrder(null);
            for (const id of store.groups.accountIds(group.id)) store.accounts.update(id, { groupId: null, sortOrder: order++ });
            store.groups.delete(group.id);
            return;
          }
          case "groupUpdate": {
            if (!store.groups.get(undo.groupId)) throw new AppError("conflict", "That group was deleted since, so the change can't be undone.");
            store.groups.update(undo.groupId, { name: undo.name, color: undo.color });
            return;
          }
          case "groupDelete": {
            if (!store.groups.get(undo.group.id)) store.groups.insert(undo.group);
            for (const a of undo.accounts) {
              const account = store.accounts.get(a.id);
              if (account && account.groupId === null) store.accounts.update(a.id, { groupId: undo.group.id, sortOrder: a.sortOrder });
            }
            return;
          }
          case "groupAssign": {
            for (const a of undo.accounts) {
              if (!store.accounts.get(a.id)) continue;
              const groupId = a.groupId && store.groups.get(a.groupId) ? a.groupId : null;
              store.accounts.update(a.id, { groupId, sortOrder: a.sortOrder });
            }
            return;
          }
        }
      });
      invalidate(env, ["groups", "accounts"]);
    },
  };
  return service;
}

export type GroupsService = ReturnType<typeof createGroupsService>;
