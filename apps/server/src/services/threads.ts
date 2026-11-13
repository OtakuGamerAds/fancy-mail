import { parseQuery } from "@fancy-mail/contracts";
import type { Activity, ModifyAction, SearchFacets, SearchResult, ThreadDetail, ThreadMark, ThreadTimer } from "@fancy-mail/contracts";

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
import { ensureDeletedLabel, keepDeletedOutOfInbox, keepServerTrash, moveKeptOutOfBin } from "./keepTrash.ts";
import { ACTION_STATE, ensureStateLabel, stateLabelIds } from "./settled.ts";
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
 * New mail in a settled, waiting or snoozed conversation (a reply, or one you sent): it's active
 * again. With `marks`, the row says why (an answer came while waiting: "Replied"; a snooze
 * ended early: "Woke"). No Activity entry (nobody did it); the labels also come off on the
 * server. Returns the conversations that changed.
 */
export function reopenThreads(env: ServiceEnv, threadIds: string[], options: { marks: boolean }): string[] {
  if (threadIds.length === 0) return [];
  const { store } = env;
  const ids = stateLabelIds(store);
  const labels = store.threads.labelIds(threadIds);
  const has = (threadId: string, id: string | undefined) => !!id && (labels.get(threadId) ?? []).includes(id);
  const open = threadIds.filter((t) => has(t, ids.settled) || has(t, ids.waiting) || has(t, ids.snoozed));
  if (open.length === 0) return [];
  const mutateEnv = { store, now: env.now };
  const change = env.db.tx(() => {
    if (options.marks) {
      for (const threadId of open) {
        const kind = has(threadId, ids.waiting) ? "replied" : has(threadId, ids.snoozed) ? "woke" : null;
        if (kind) store.threadStates.setMark({ threadId, kind, at: env.now() });
      }
    }
    store.threadStates.clearTimers(open);
    // An answer while waiting or snoozed: back in the inbox too (a message you sent isn't).
    const back = options.marks ? open.filter((t) => has(t, ids.waiting) || has(t, ids.snoozed)) : [];
    return applyChange(env, [
      ...(["unsettle", "unwait", "unsnooze"] as const).map((type) => ({ action: type, plan: () => planAction(mutateEnv, open, { type }).deltas })),
      { action: "moveToInbox", plan: () => planAction(mutateEnv, back, { type: "moveToInbox" }).deltas },
    ]);
  });
  return change.threadIds;
}

/**
 * Waiting and snoozed conversations whose time is up come back: "No reply" for a wait that ran
 * out, "Woke" for a snooze. Returns the conversations that came back.
 */
export function wakeDueThreads(env: ServiceEnv): string[] {
  const { store } = env;
  const now = env.now();
  const due = store.threadStates.due(now);
  if (due.length === 0) return [];
  const ids = stateLabelIds(store);
  const labels = store.threads.labelIds(due.map((t) => t.threadId));
  const mutateEnv = { store, now: env.now };
  const woken: string[] = [];
  const change = env.db.tx(() => {
    for (const timer of due) {
      const labelId = timer.kind === "waiting" ? ids.waiting : ids.snoozed;
      // Undone or changed meanwhile: the label is gone, so only the timer goes.
      if (labelId && (labels.get(timer.threadId) ?? []).includes(labelId)) {
        woken.push(timer.threadId);
        store.threadStates.setMark({ threadId: timer.threadId, kind: timer.kind === "waiting" ? "noReply" : "woke", at: now });
      }
    }
    store.threadStates.clearTimers(due.map((t) => t.threadId));
    if (woken.length === 0) return null;
    // Back where you look: the inbox (a message you sent and waited on isn't in it).
    return applyChange(
      env,
      (["unwait", "unsnooze", "moveToInbox"] as const).map((type) => ({ action: type, plan: () => planAction(mutateEnv, woken, { type }).deltas })),
    );
  });
  return change?.threadIds ?? [];
}

/** "Send and wait": once the message is out, its conversation waits for an answer until then. */
export function waitQuietly(env: ServiceEnv, threadIds: string[], until: number): void {
  if (threadIds.length === 0) return;
  const mutateEnv = { store: env.store, now: env.now };
  env.db.tx(() => {
    ensureStateLabel(env.store, "waiting", env.now());
    for (const threadId of threadIds) env.store.threadStates.setTimer({ threadId, kind: "waiting", until, setAt: env.now() });
    env.store.threadStates.clearMarks(threadIds);
    applyChange(env, [{ action: "wait", plan: () => planAction(mutateEnv, threadIds, { type: "wait", until }).deltas }]);
  });
  invalidate(env, ["labels"]);
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
      // Deleting for good is the person's own decision: agents only delete (kept, in Deleted).
      if (isAgent(ctx) && actions.some((a) => a.type === "deleteForGood")) {
        throw new AppError("forbidden", "Only the user can delete mail for good. Use trash: it keeps the mail in Deleted, where they can look at it.");
      }
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
      for (const action of actions) {
        if ((action.type === "wait" || action.type === "snooze") && !(action.until > env.now())) {
          throw new AppError("bad_request", `${action.type === "wait" ? "Waiting" : "Snoozing"} needs a time in the future.`);
        }
      }
      let labelCreated = false;
      const createdMailboxes: { accountId: string; mailbox: { id: string; path: string; role: string | null } }[] = [];
      let activity: Activity | null = null;
      const result = env.db.tx(() => {
        // The state labels an action adds exist from its first use (Deleted too).
        if (actions.some((a) => a.type === "trash")) labelCreated = ensureDeletedLabel(store, env.now()).created || labelCreated;
        for (const action of actions) {
          const key = ACTION_STATE[action.type];
          if (key) labelCreated = ensureStateLabel(store, key, env.now()).created || labelCreated;
        }
        // When waiting and snoozed conversations come back, and the "Replied"/"No reply" marks
        // (handled now) go.
        for (const action of actions) {
          if (action.type === "wait" || action.type === "snooze") {
            for (const threadId of unique) store.threadStates.setTimer({ threadId, kind: action.type === "wait" ? "waiting" : "snoozed", until: action.until, setAt: env.now() });
          } else if (["settle", "pin", "unwait", "unsnooze"].includes(action.type)) {
            store.threadStates.clearTimers(unique);
          }
          if (ACTION_STATE[action.type] || action.type.startsWith("un")) store.threadStates.clearMarks(unique);
        }
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

    /** Sync engine: these got new mail, so they're active again (and say why). */
    reopen(threadIds: string[]): string[] {
      return reopenThreads(env, threadIds, { marks: true });
    },

    /** Once per account: what is in Gmail's Bin moves out to Deleted (kept). */
    keepServerTrash(): Map<string, number> {
      return keepServerTrash(env);
    },

    /** Once per Gmail account: kept mail still in the Bin moves into the Deleted folder. */
    moveKeptOutOfBin(): Map<string, number> {
      return moveKeptOutOfBin(env);
    },

    /** Deleted mail stays out of the inbox (old labels come back when mail leaves the Bin). */
    keepDeletedOutOfInbox(): string[] {
      return keepDeletedOutOfInbox(env);
    },

    /** Waiting and snoozed conversations whose time is up come back (a timer calls this). */
    wakeDue(): string[] {
      return wakeDueThreads(env);
    },

    /** When waiting and snoozed conversations come back, and why some came back. */
    states(ctx: CallContext): { timers: ThreadTimer[]; marks: ThreadMark[] } {
      const visible = visibleAccountIds(ctx, store.accounts.list());
      const timers = store.threadStates.timers();
      const marks = store.threadStates.marks();
      if (!visible) return { timers, marks };
      const ok = new Set(store.threads.byIds([...new Set([...timers, ...marks].map((t) => t.threadId))]).filter((r) => visible.includes(r.account_id)).map((r) => r.id));
      return { timers: timers.filter((t) => ok.has(t.threadId)), marks: marks.filter((m) => ok.has(m.threadId)) };
    },

    /** The conversation was opened: its "Replied" / "No reply" / "Woke" goes. */
    clearMark(threadId: string, ctx: CallContext): void {
      visibleThread(threadId, ctx);
      if (store.threadStates.clearMark(threadId)) invalidate(env, ["threads"], [threadId]);
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
