import type { Label } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import type { LabelCounts } from "../store/labels.ts";
import type { LabelRecord } from "../store/types.ts";
import { requireAnyAccess, visibleAccountIds } from "./context.ts";
import type { CallContext } from "./context.ts";
import { invalidate, notifyOutbox, writeActivity } from "./env.ts";
import type { ServiceEnv } from "./env.ts";
import { applyChange } from "./threads.ts";
import type { MessageDelta } from "./mutate.ts";

export type LabelUndo =
  | { type: "labelCreate"; labelId: string }
  | { type: "labelUpdate"; labelId: string; name: string; color: string | null }
  | { type: "labelDelete"; label: LabelRecord; messageIds: string[] };

const HEX = /^#[0-9a-fA-F]{6}$/;
const RESERVED = new Set(["none"]);

export function validColor(color: string | null | undefined, what: string): string | null | undefined {
  if (color === undefined || color === null) return color;
  if (!HEX.test(color)) throw new AppError("bad_request", `${what} color must be a hex color like #3b82f6.`);
  return color.toLowerCase();
}

export function createLabelsService(env: ServiceEnv) {
  const { store } = env;

  function cleanName(name: string): string {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean) throw new AppError("bad_request", "A label needs a name.");
    if (clean.length > 100) throw new AppError("bad_request", "Label names can be at most 100 characters.");
    if (RESERVED.has(clean.toLowerCase())) throw new AppError("bad_request", `"${clean}" is reserved by search (label:none). Pick another name.`);
    return clean;
  }

  function toLabel(record: LabelRecord, counts: Map<string, LabelCounts>): Label {
    const c = counts.get(record.id);
    return {
      id: record.id,
      name: record.name,
      color: record.color,
      sortOrder: record.sortOrder,
      threadCount: c?.threads ?? 0,
      unreadThreadCount: c?.unread ?? 0,
      byAccount: c?.byAccount ?? {},
    };
  }

  function one(id: string, ctx?: CallContext): Label {
    const record = store.labels.get(id);
    if (!record) throw new AppError("not_found", `No label with id ${id}. It may have been deleted.`);
    return toLabel(record, counts(ctx));
  }

  function counts(ctx?: CallContext) {
    const visible = ctx ? visibleAccountIds(ctx, store.accounts.list()) : null;
    return store.labels.counts(visible);
  }

  function requireLabel(id: string): LabelRecord {
    const record = store.labels.get(id);
    if (!record) throw new AppError("not_found", `No label with id ${id}. It may have been deleted.`);
    return record;
  }

  /** Mirrors a rename or delete to every real account (Gmail label / IMAP keyword). */
  function mirror(payload: { kind: "labelRename"; from: string; to: string } | { kind: "labelDelete"; name: string }): string[] {
    const ids = store.accounts
      .list()
      .filter((a) => !a.isDemo)
      .map((a) => a.id);
    for (const id of ids) store.outbox.enqueue(id, payload, env.now());
    return ids;
  }

  function publishActivity(activity: ReturnType<typeof writeActivity>): void {
    invalidate(env, ["labels", "activity"]);
    env.bus.publish({ type: "activity", activity });
  }

  const service = {
    list(ctx?: CallContext): Label[] {
      const c = counts(ctx);
      return store.labels.list().map((l) => toLabel(l, c));
    },

    get: one,

    /** By id, or by name (case-insensitive). */
    resolve(nameOrId: string): Label | null {
      const record = store.labels.get(nameOrId.trim()) ?? store.labels.findByName(nameOrId);
      return record ? toLabel(record, counts()) : null;
    },

    create(input: { name: string; color?: string | null }, ctx: CallContext): Label {
      requireAnyAccess(ctx, store.accounts.list(), "organize", "Creating labels");
      const name = cleanName(input.name);
      const color = validColor(input.color, "The label") ?? null;
      const record: LabelRecord = { id: newId("lbl"), name, color, sortOrder: 0, createdAt: env.now() };
      const activity = env.db.tx(() => {
        if (store.labels.findByName(name)) throw new AppError("conflict", `There's already a label named "${name}".`);
        record.sortOrder = store.labels.nextSortOrder();
        store.labels.insert(record);
        return writeActivity(env, {
          actor: ctx.actor,
          summary: `Created the label ${name}`,
          kind: "label",
          undo: { type: "labelCreate", labelId: record.id } satisfies LabelUndo,
        });
      });
      publishActivity(activity);
      return toLabel(record, new Map());
    },

    /** The label with this name, created when missing. */
    ensure(name: string, ctx: CallContext): Label {
      const existing = store.labels.findByName(name.replace(/\s+/g, " ").trim());
      if (existing) return toLabel(existing, counts(ctx));
      return service.create({ name }, ctx);
    },

    update(input: { labelId: string; name?: string; color?: string | null }, ctx: CallContext): Label {
      requireAnyAccess(ctx, store.accounts.list(), "organize", "Changing labels");
      const before = requireLabel(input.labelId);
      const name = input.name !== undefined ? cleanName(input.name) : undefined;
      const color = validColor(input.color, "The label");
      const renamed = name !== undefined && name !== before.name;
      const recolored = color !== undefined && color !== before.color;
      if (!renamed && !recolored) return one(before.id, ctx);
      let outboxAccounts: string[] = [];
      const activity = env.db.tx(() => {
        if (renamed) {
          const clash = store.labels.findByName(name);
          if (clash && clash.id !== before.id) throw new AppError("conflict", `There's already a label named "${name}".`);
        }
        store.labels.update(before.id, { name: renamed ? name : undefined, color: recolored ? color : undefined });
        if (renamed) outboxAccounts = mirror({ kind: "labelRename", from: before.name, to: name });
        return writeActivity(env, {
          actor: ctx.actor,
          summary: renamed ? `Renamed the label ${before.name} to ${name}` : `Changed the color of ${before.name}`,
          kind: "label",
          undo: { type: "labelUpdate", labelId: before.id, name: before.name, color: before.color } satisfies LabelUndo,
        });
      });
      notifyOutbox(env, outboxAccounts);
      publishActivity(activity);
      if (renamed) invalidate(env, ["threads"]);
      return one(before.id, ctx);
    },

    delete(input: { labelId: string }, ctx: CallContext): { removedFrom: number } {
      requireAnyAccess(ctx, store.accounts.list(), "organize", "Deleting labels");
      const label = requireLabel(input.labelId);
      const tagged = store.labels.messagesWithLabel(label.id);
      const threadIds = [...new Set(tagged.map((t) => t.threadId))];
      let outboxAccounts: string[] = [];
      const activity = env.db.tx(() => {
        store.labels.delete(label.id); // message_labels and thread_labels cascade
        store.refreshThreads(threadIds);
        outboxAccounts = mirror({ kind: "labelDelete", name: label.name });
        return writeActivity(env, {
          actor: ctx.actor,
          summary:
            threadIds.length > 0
              ? `Deleted the label ${label.name} (it was on ${threadIds.length === 1 ? "1 conversation" : `${threadIds.length} conversations`})`
              : `Deleted the label ${label.name}`,
          kind: "label",
          threadIds,
          undo: { type: "labelDelete", label, messageIds: tagged.map((t) => t.messageId) } satisfies LabelUndo,
        });
      });
      notifyOutbox(env, outboxAccounts);
      invalidate(env, ["threads", "labels", "activity"], threadIds.length > 0 && threadIds.length < 500 ? threadIds : undefined);
      env.bus.publish({ type: "activity", activity });
      return { removedFrom: threadIds.length };
    },

    reorder(input: { labelIds: string[] }, ctx: CallContext): void {
      requireAnyAccess(ctx, store.accounts.list(), "organize", "Reordering labels");
      env.db.tx(() => {
        const known = new Set(store.labels.list().map((l) => l.id));
        let order = 0;
        for (const id of input.labelIds) if (known.has(id)) store.labels.update(id, { sortOrder: order++ });
        // Labels left out keep their relative order after the ones given.
        for (const l of store.labels.list()) if (!input.labelIds.includes(l.id)) store.labels.update(l.id, { sortOrder: order++ });
      });
      invalidate(env, ["labels", "threads"]);
    },

    /** Undo for label changes (called by activity.undo). Returns the threads it touched. */
    undo(undo: LabelUndo): string[] {
      switch (undo.type) {
        case "labelCreate": {
          const label = store.labels.get(undo.labelId);
          if (!label) return [];
          const threadIds = [...new Set(store.labels.messagesWithLabel(label.id).map((t) => t.threadId))];
          let accounts: string[] = [];
          env.db.tx(() => {
            store.labels.delete(label.id);
            store.refreshThreads(threadIds);
            accounts = mirror({ kind: "labelDelete", name: label.name });
          });
          notifyOutbox(env, accounts);
          invalidate(env, ["labels", "threads"]);
          return threadIds;
        }
        case "labelUpdate": {
          const label = store.labels.get(undo.labelId);
          if (!label) throw new AppError("conflict", "That label was deleted since, so the change can't be undone.");
          let accounts: string[] = [];
          env.db.tx(() => {
            const clash = store.labels.findByName(undo.name);
            if (clash && clash.id !== label.id) {
              throw new AppError("conflict", `Can't rename it back: there's now another label named "${undo.name}".`);
            }
            store.labels.update(label.id, { name: undo.name, color: undo.color });
            if (label.name !== undo.name) accounts = mirror({ kind: "labelRename", from: label.name, to: undo.name });
          });
          notifyOutbox(env, accounts);
          invalidate(env, ["labels", "threads"]);
          return [];
        }
        case "labelDelete": {
          if (store.labels.findByName(undo.label.name)) {
            throw new AppError("conflict", `There's a label named "${undo.label.name}" again, so the old one can't come back.`);
          }
          let threadIds: string[] = [];
          env.db.tx(() => {
            store.labels.insert(undo.label);
            const deltas: MessageDelta[] = undo.messageIds.map((messageId) => ({
              messageId,
              addLocations: [],
              removeLocations: [],
              addLabels: [undo.label.id],
              removeLabels: [],
            }));
            threadIds = applyChange(env, [{ action: "undo:labelDelete", plan: () => deltas }], { publish: false }).threadIds;
          });
          invalidate(env, ["labels", "threads"], threadIds.length > 0 && threadIds.length < 500 ? threadIds : undefined);
          return threadIds;
        }
      }
    },
  };
  return service;
}

export type LabelsService = ReturnType<typeof createLabelsService>;
