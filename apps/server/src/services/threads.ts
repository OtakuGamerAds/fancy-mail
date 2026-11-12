import { parseQuery } from "@fancy-mail/contracts";
import type { Activity, ModifyAction, SearchFacets, SearchResult, ThreadDetail } from "@fancy-mail/contracts";

import type { SqlValue } from "../db/sqlite.ts";
import { AppError } from "../errors.ts";
import { compileQuery, decodeCursor, encodeCursor } from "../search/compile.ts";
import type { CompileLookups } from "../search/compile.ts";
import { toContractDraft } from "../store/drafts.ts";
import { toContractMessage } from "../store/messages.ts";
import { toThreadSummary } from "../store/threads.ts";
import type { ThreadRow } from "../store/threads.ts";
import type { AccountRecord } from "../store/types.ts";
import { canSee, isAgent, requireAccess, visibleAccountIds } from "./context.ts";
import type { CallContext } from "./context.ts";
import { invalidate, notifyOutbox, writeActivity } from "./env.ts";
import type { ServiceEnv } from "./env.ts";
import { applyDeltas, invertDelta, locationsOf, outboxOpsFor, planAction, summarize } from "./mutate.ts";
import { ensureSettledLabel } from "./settled.ts";
import type { MessageDelta } from "./mutate.ts";

const DEFAULT_LIMIT = 50;
const TEXT_SCAN_THRESHOLD = 1500;
const MAX_IDS = 5000;

/** Stored as activity.undo for conversation changes: the inverse steps, in the order to apply them. */
export interface ModifyUndoRecord {
  type: "modify";
  steps: { action: string; deltas: MessageDelta[] }[];
}

export interface ChangeResult {
  threadIds: string[];
  accountIds: string[];
  /** Inverse steps, ready to store for Undo. */
  undoSteps: { action: string; deltas: MessageDelta[] }[];
}

/**
 * Applies steps of deltas (planned actions, or a stored undo) in one transaction: database,
 * outbox, thread cache. Publishes invalidations. Shared by modify, undo, label deletes and the
 * demo seed.
 */
export function applyChange(
  env: ServiceEnv,
  steps: { action: string; plan: () => MessageDelta[] }[],
  options: { publish?: boolean } = {},
): ChangeResult {
  const threadIds = new Set<string>();
  const accountIds = new Set<string>();
  const undoSteps: { action: string; deltas: MessageDelta[] }[] = [];
  let countsChanged = false;
  let labelsChanged = false;
  const outboxAccounts = new Set<string>();

  env.db.tx(() => {
    for (const step of steps) {
      const deltas = step.plan();
      if (deltas.length === 0) continue;
      const before = locationsOf(env.store, deltas);
      const result = applyDeltas({ store: env.store, now: env.now }, deltas);
      if (result.applied.length === 0) continue;
      for (const id of result.threadIds) threadIds.add(id);
      for (const id of result.accountIds) accountIds.add(id);
      countsChanged ||= result.countsChanged;
      labelsChanged ||= result.labelsChanged;
      for (const op of outboxOpsFor(env.store, result.applied, step.action, before)) {
        env.store.outbox.enqueue(op.accountId, op.payload, env.now());
        outboxAccounts.add(op.accountId);
      }
      undoSteps.unshift({ action: step.action, deltas: result.applied.map(invertDelta) });
    }
    env.store.refreshThreads(threadIds);
  });

  if (options.publish !== false && threadIds.size > 0) {
    const topics: ("threads" | "accounts" | "groups" | "mailboxes" | "labels")[] = ["threads"];
    if (countsChanged) topics.push("accounts", "groups", "mailboxes", "labels");
    else if (labelsChanged) topics.push("labels");
    invalidate(env, topics, [...threadIds]);
  }
  notifyOutbox(env, outboxAccounts);
  return { threadIds: [...threadIds], accountIds: [...accountIds], undoSteps };
}

/**
 * New mail in a settled conversation (a reply, or one you sent): it isn't settled any more. No
 * Activity entry (nobody did it); the label also comes off on the server.
 */
export function unsettleThreads(env: ServiceEnv, threadIds: string[]): string[] {
  if (threadIds.length === 0) return [];
  return applyChange(env, [{ action: "unsettle", plan: () => planAction({ store: env.store, now: env.now }, threadIds, { type: "unsettle" }).deltas }])
    .threadIds;
}

/** Applies a stored undo (or any list of delta steps) as-is. */
export function applyUndoSteps(env: ServiceEnv, steps: { action: string; deltas: MessageDelta[] }[]): ChangeResult {
  return applyChange(
    env,
    steps.map((s) => ({ action: `undo:${s.action}`, plan: () => s.deltas })),
  );
}

export function compileLookups(env: ServiceEnv): CompileLookups {
  return {
    labels: env.store.labels.list().map((l) => ({ id: l.id, name: l.name })),
    accounts: env.store.accounts.list().map((a) => ({ id: a.id, email: a.email, displayName: a.displayName, groupId: a.groupId })),
    groups: env.store.groups.list().map((g) => ({ id: g.id, name: g.name })),
  };
}

export function createThreadsService(env: ServiceEnv) {
  const { store } = env;

  function accountFor(row: ThreadRow): AccountRecord {
    const account = store.accounts.get(row.account_id);
    if (!account) throw new AppError("not_found", `No conversation with id ${row.id}. It may have been deleted.`);
    return account;
  }

  /** The thread, if this caller may see it; not_found otherwise (hidden accounts look absent). */
  function visibleThread(threadId: string, ctx: CallContext): { row: ThreadRow; account: AccountRecord } {
    const row = store.threads.get(threadId);
    const account = row ? store.accounts.get(row.account_id) : null;
    if (!row || !account || !canSee(ctx, account)) {
      throw new AppError("not_found", `No conversation with id ${threadId}. It may have been deleted.`);
    }
    return { row, account };
  }

  function compile(query: string, ctx: CallContext, textScan = false) {
    const parsed = parseQuery(query, env.now());
    const visible = visibleAccountIds(ctx, store.accounts.list());
    const lookups = compileLookups(env);
    const compiled = compileQuery(parsed, lookups, { ...(visible ? { visibleAccountIds: visible } : {}), textScan });
    return { compiled, errors: [...parsed.errors, ...compiled.errors], parsed, lookups, visible };
  }

  /**
   * Words searched for: the mail servers are asked too (Gmail searches all the mail and its
   * text, more than is downloaded here). What they find comes down and the list updates.
   */
  function askServers(parsed: ReturnType<typeof parseQuery>, visible: string[] | null): void {
    const quote = (w: string) => (/\s/.test(w) ? `"${w.replace(/"/g, "")}"` : w);
    // Words and from:/to:/cc:/subject:/filename: mean the same in Gmail's search.
    const parts = parsed.terms.flatMap((t) => {
      if ((t.kind !== "text" && t.kind !== "field") || t.negated) return [];
      const value = t.value.trim();
      if (!value) return [];
      return [t.kind === "field" ? `${t.field}:${quote(value)}` : quote(value)];
    });
    const text = parts.join(" ");
    if (text.length < 2) return;
    const accountIds = visible ?? store.accounts.list().map((a) => a.id);
    try {
      env.sync().searchServer({ text, accountIds });
    } catch (error) {
      env.log.warn("could not ask the mail servers", { error });
    }
  }

  const service = {
    search(input: { query: string; cursor?: string | null; limit?: number }, ctx: CallContext): SearchResult {
      const limit = Math.max(1, Math.min(500, input.limit ?? DEFAULT_LIMIT));
      let after: { at: number; id: string } | null = null;
      if (input.cursor) {
        after = decodeCursor(input.cursor);
        if (!after) throw new AppError("bad_request", "That page cursor isn't valid. Start the search again without a cursor.");
      }
      const { compiled, errors, parsed, lookups, visible } = compile(input.query, ctx);
      // Words that match a lot of mail: walk the list in date order for the page instead of
      // looking up thousands of conversations (the count still uses the lookup).
      let list = { where: compiled.where, params: compiled.params as SqlValue[] };
      if (compiled.match && store.threads.textHits(compiled.match) > TEXT_SCAN_THRESHOLD) {
        const scan = compileQuery(parsed, lookups, { ...(visible ? { visibleAccountIds: visible } : {}), textScan: true });
        list = { where: scan.where, params: scan.params as SqlValue[] };
      }
      if (!input.cursor) askServers(parsed, visible);
      const { rows, total } = store.threads.search(list, { where: compiled.where, params: compiled.params as SqlValue[] }, { after, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const labels = store.threads.labelIds(page.map((r) => r.id));
      const last = page.at(-1);
      return {
        threads: page.map((r) => toThreadSummary(r, labels.get(r.id) ?? [])),
        nextCursor: rows.length > limit && last ? encodeCursor(last.last_message_at, last.id) : null,
        total,
        queryErrors: errors,
      };
    },

    /** Where a query's matches are, per account and per label (hidden accounts stay out). */
    facets(input: { query: string }, ctx: CallContext): SearchFacets {
      const { compiled, errors } = compile(input.query, ctx);
      const { byAccount, byLabel } = store.threads.facets(compiled.where, compiled.params as SqlValue[]);
      let total = 0;
      for (const n of byAccount.values()) total += n;
      return { total, byAccount: Object.fromEntries(byAccount), byLabel: Object.fromEntries(byLabel), queryErrors: errors };
    },

    /** Every thread id a query matches (up to `max`), for actions "on everything that matches". */
    searchIds(query: string, ctx: CallContext, max = MAX_IDS): { ids: string[]; total: number; errors: string[] } {
      const { compiled, errors } = compile(query, ctx);
      const ids = store.threads.searchIds(compiled.where, compiled.params as SqlValue[], max + 1);
      return { ids: ids.slice(0, max), total: ids.length > max ? max + 1 : ids.length, errors };
    },

    get(threadId: string, ctx: CallContext): ThreadDetail {
      const { row } = visibleThread(threadId, ctx);
      const messages = store.messages.forThread(threadId);
      const ids = messages.map((m) => m.id);
      const labelRows = store.messages.labels(ids);
      const attachments = store.messages.attachments(ids);
      const bodies = store.messages.bodies(ids);
      const missing = messages.filter((m) => m.bodyState === "none").map((m) => m.id);
      if (missing.length > 0) {
        try {
          env.sync().requestBodies(missing);
        } catch (error) {
          env.log.warn("could not ask for bodies", { threadId, error });
        }
      }
      const labelIds = store.threads.labelIds([threadId]).get(threadId) ?? [];
      return {
        thread: toThreadSummary(row, labelIds),
        messages: messages.map((m) =>
          toContractMessage(
            m,
            labelRows.filter((l) => l.messageId === m.id).map((l) => l.labelId),
            attachments.filter((a) => a.messageId === m.id),
            bodies.get(m.id) ?? null,
          ),
        ),
        drafts: store.drafts.forThread(threadId).map(toContractDraft),
      };
    },

    fetchBodies(threadId: string, ctx: CallContext): void {
      visibleThread(threadId, ctx);
      const missing = store.messages
        .forThread(threadId)
        .filter((m) => m.bodyState !== "ready")
        .map((m) => m.id);
      if (missing.length > 0) env.sync().requestBodies(missing);
    },

    /** Asks for missing bodies and waits until they are in (or failed), or until the timeout. */
    async ensureBodies(threadId: string, ctx: CallContext, timeoutMs = 20_000): Promise<void> {
      visibleThread(threadId, ctx);
      const pending = () => store.messages.forThread(threadId).filter((m) => m.bodyState === "none").map((m) => m.id);
      const first = pending();
      if (first.length === 0) return;
      env.sync().requestBodies(first);
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        const unsubscribe = env.bus.subscribe((event) => {
          if (event.type !== "invalidate" || !event.topics.includes("threads")) return;
          if (event.threadIds && !event.threadIds.includes(threadId)) return;
          if (pending().length === 0) finish();
        });
        if (pending().length === 0) finish();
      });
    },

    modify(threadIds: string[], actions: ModifyAction[], ctx: CallContext): { activity: Activity | null } {
      const unique = [...new Set(threadIds)];
      if (unique.length === 0 || actions.length === 0) return { activity: null };
      // Every thread must exist (and be visible); agents need "organize" on each account.
      const accounts = new Map<string, AccountRecord>();
      for (const id of unique) {
        const { row } = visibleThread(id, ctx);
        if (!accounts.has(row.account_id)) accounts.set(row.account_id, accountFor(row));
      }
      for (const account of accounts.values()) requireAccess(ctx, account, "organize", "changing conversations");
      for (const action of actions) {
        if (action.type === "addLabels" || action.type === "removeLabels") {
          for (const labelId of action.labelIds) {
            if (!store.labels.get(labelId)) {
              throw new AppError("bad_request", `No label with id ${labelId}. Create it first, or use one from the label list.`);
            }
          }
        }
      }

      const mutateEnv = { store, now: env.now };
      let labelCreated = false;
      const createdMailboxes: { accountId: string; mailbox: { id: string; path: string; role: string | null } }[] = [];
      let activity: Activity | null = null;
      const result = env.db.tx(() => {
        if (actions.some((a) => a.type === "settle")) labelCreated = ensureSettledLabel(store, env.now()).created;
        const change = applyChange(
          env,
          actions.map((action) => ({
            action: action.type,
            plan: () => {
              const planned = planAction(mutateEnv, unique, action);
              for (const mb of planned.createdMailboxes) {
                createdMailboxes.push({ accountId: mb.accountId, mailbox: mb });
                if (!store.accounts.isDemo(mb.accountId)) {
                  store.outbox.enqueue(mb.accountId, { kind: "createMailbox", mailbox: { id: mb.id, path: mb.path, role: mb.role } });
                }
              }
              return planned.deltas;
            },
          })),
          { publish: false },
        );
        if (change.threadIds.length > 0) {
          const labelName = (id: string) => store.labels.get(id)?.name ?? "a label";
          activity = writeActivity(env, {
            actor: ctx.actor,
            summary: summarize(actions, change.threadIds.length, labelName),
            kind: "modify",
            threadIds: change.threadIds,
            accountIds: change.accountIds,
            undo: { type: "modify", steps: change.undoSteps } satisfies ModifyUndoRecord,
          });
        }
        return change;
      });

      if (result.threadIds.length > 0) {
        invalidate(env, ["threads", "accounts", "groups", "mailboxes", "labels", "activity"], result.threadIds);
      }
      if (createdMailboxes.length > 0) invalidate(env, ["mailboxes"]);
      if (labelCreated && result.threadIds.length === 0) invalidate(env, ["labels"]);
      if (activity) env.bus.publish({ type: "activity", activity });
      return { activity };
    },

    /** Sync engine: these got new mail, so they aren't settled any more. */
    unsettle(threadIds: string[]): string[] {
      return unsettleThreads(env, threadIds);
    },

    /** Re-derives cached thread rows (sync engine and tests). */
    refresh(threadIds: string[]): void {
      store.refreshThreads(threadIds);
    },

    isVisible(threadId: string, ctx: CallContext): boolean {
      if (!isAgent(ctx)) return store.threads.get(threadId) !== null;
      try {
        visibleThread(threadId, ctx);
        return true;
      } catch {
        return false;
      }
    },
  };
  return service;
}

export type ThreadsService = ReturnType<typeof createThreadsService>;
