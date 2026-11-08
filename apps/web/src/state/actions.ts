/**
 * Every change the person makes goes through here: applied to the cached lists first (so the
 * row moves at once), then sent to the server, then confirmed by its `invalidate`. Each one
 * ends in a toast with the server's summary and Undo.
 */
import {
  parseQuery,
  type Activity,
  type Bootstrap,
  type ModifyAction,
  type RpcParams,
  type Settings,
  type ThreadDetail,
  type ThreadSummary,
} from "@fancy-mail/contracts";

import { toast } from "~/components/ui/toast";
import { errorMessage, rpc } from "~/rpc/client";
import { qk, queryClient, type ThreadPages } from "./queries";
import { useUi } from "./ui";

// ── Optimistic list updates ─────────────────────────────────────────────────────────────────

interface QueryShape {
  inValues: Set<string>;
  isUnread: boolean;
  isStarred: boolean;
  labelValues: Set<string>;
}

const shapeCache = new Map<string, QueryShape>();

function shapeOf(query: string): QueryShape {
  const cached = shapeCache.get(query);
  if (cached) return cached;
  const parsed = parseQuery(query);
  const shape: QueryShape = { inValues: new Set(), isUnread: false, isStarred: false, labelValues: new Set() };
  for (const term of parsed.terms) {
    if (term.kind === "in" && !term.negated) shape.inValues.add(term.value);
    if (term.kind === "is" && !term.negated && term.value === "unread") shape.isUnread = true;
    if (term.kind === "is" && !term.negated && term.value === "starred") shape.isStarred = true;
    if (term.kind === "label" && !term.negated) shape.labelValues.add(term.value.toLowerCase());
  }
  shapeCache.set(query, shape);
  return shape;
}

function applyToSummary(thread: ThreadSummary, actions: ModifyAction[]): ThreadSummary {
  let next = thread;
  for (const action of actions) {
    switch (action.type) {
      case "markRead":
        next = { ...next, unreadCount: 0 };
        break;
      case "markUnread":
        next = { ...next, unreadCount: Math.max(1, next.unreadCount) };
        break;
      case "star":
        next = { ...next, starred: true };
        break;
      case "unstar":
        next = { ...next, starred: false };
        break;
      case "archive":
        next = { ...next, inInbox: false };
        break;
      case "moveToInbox":
        next = { ...next, inInbox: true, inTrash: false, inSpam: false };
        break;
      case "trash":
        next = { ...next, inTrash: true, inInbox: false };
        break;
      case "restore":
        next = { ...next, inTrash: false };
        break;
      case "markSpam":
        next = { ...next, inSpam: true, inInbox: false };
        break;
      case "notSpam":
        next = { ...next, inSpam: false, inInbox: true };
        break;
      case "addLabels":
        next = { ...next, labelIds: [...new Set([...next.labelIds, ...action.labelIds])] };
        break;
      case "removeLabels":
        next = { ...next, labelIds: next.labelIds.filter((id) => !action.labelIds.includes(id)) };
        break;
    }
  }
  return next;
}

/** Whether a changed conversation clearly no longer belongs in a list (it leaves at once). */
function leavesList(query: string, before: ThreadSummary, after: ThreadSummary, labelNames: Map<string, string>): boolean {
  const shape = shapeOf(query);
  const anywhere = shape.inValues.has("anywhere");
  if (shape.inValues.has("inbox") && before.inInbox && !after.inInbox) return true;
  if (shape.inValues.has("archive") && after.inInbox) return true;
  if (shape.inValues.has("trash") && before.inTrash && !after.inTrash) return true;
  if (shape.inValues.has("spam") && before.inSpam && !after.inSpam) return true;
  if (!anywhere && !shape.inValues.has("trash") && !before.inTrash && after.inTrash) return true;
  if (!anywhere && !shape.inValues.has("spam") && !before.inSpam && after.inSpam) return true;
  if ((shape.isStarred || shape.inValues.has("starred")) && before.starred && !after.starred) return true;
  if (shape.labelValues.size > 0) {
    for (const removed of before.labelIds.filter((id) => !after.labelIds.includes(id))) {
      const name = labelNames.get(removed)?.toLowerCase();
      if (shape.labelValues.has(removed.toLowerCase()) || (name && shape.labelValues.has(name))) return true;
    }
  }
  return false;
}

interface Snapshot {
  lists: [readonly unknown[], ThreadPages | undefined][];
  details: [readonly unknown[], ThreadDetail | undefined][];
}

function applyOptimistic(threadIds: string[], actions: ModifyAction[]): Snapshot {
  const ids = new Set(threadIds);
  const bootstrap = queryClient.getQueryData<Bootstrap>(qk.bootstrap);
  const labelNames = new Map((bootstrap?.labels ?? []).map((l) => [l.id, l.name]));
  const snapshot: Snapshot = { lists: [], details: [] };

  for (const [key, data] of queryClient.getQueriesData<ThreadPages>({ queryKey: qk.threadsAll })) {
    if (!data) continue;
    snapshot.lists.push([key, data]);
    const query = String(key[1] ?? "");
    let removed = 0;
    const pages = data.pages.map((page) => {
      let changed = false;
      const threads: ThreadSummary[] = [];
      for (const thread of page.threads) {
        if (!ids.has(thread.id)) {
          threads.push(thread);
          continue;
        }
        changed = true;
        const next = applyToSummary(thread, actions);
        if (leavesList(query, thread, next, labelNames)) removed++;
        else threads.push(next);
      }
      return changed ? { ...page, threads } : page;
    });
    if (removed > 0 && pages[0]) pages[0] = { ...pages[0], total: Math.max(0, pages[0].total - removed) };
    queryClient.setQueryData<ThreadPages>(key, { ...data, pages });
  }

  for (const id of threadIds) {
    const key = qk.thread(id);
    const detail = queryClient.getQueryData<ThreadDetail>(key);
    if (!detail) continue;
    snapshot.details.push([key, detail]);
    const markRead = actions.some((a) => a.type === "markRead");
    const markUnread = actions.some((a) => a.type === "markUnread");
    queryClient.setQueryData<ThreadDetail>(key, {
      ...detail,
      thread: applyToSummary(detail.thread, actions),
      messages: detail.messages.map((m, index) => ({
        ...m,
        unread: markRead ? false : markUnread && index === detail.messages.length - 1 ? true : m.unread,
      })),
    });
  }
  return snapshot;
}

function restore(snapshot: Snapshot) {
  for (const [key, data] of snapshot.lists) queryClient.setQueryData(key, data);
  for (const [key, data] of snapshot.details) queryClient.setQueryData(key, data);
}

// ── Changing conversations ──────────────────────────────────────────────────────────────────

export interface ModifyOptions {
  /** No toast (opening a conversation marks it read quietly). */
  quiet?: boolean;
}

export async function modifyThreads(
  threadIds: string[],
  actions: ModifyAction[],
  options: ModifyOptions = {},
): Promise<Activity | null> {
  if (threadIds.length === 0 || actions.length === 0) return null;
  const snapshot = applyOptimistic(threadIds, actions);
  try {
    const { activity } = await rpc("threads.modify", { threadIds, actions });
    if (activity && activity.undoable) useUi.getState().pushUndo(activity.id);
    if (activity && !options.quiet) showActivityToast(activity);
    return activity;
  } catch (error) {
    restore(snapshot);
    toast.error("That didn't work", errorMessage(error));
    return null;
  }
}

export function showActivityToast(activity: Activity, extra?: { onShow?: () => void; title?: string }) {
  toast.show({
    id: `activity-${activity.id}`,
    type: activity.actor.kind === "agent" ? "agent" : "plain",
    title: extra?.title ?? activity.summary,
    duration: 6000,
    actions: [
      ...(activity.undoable && !activity.undoneAt
        ? [{ label: "Undo", onClick: () => void undoActivity(activity.id) }]
        : []),
      ...(extra?.onShow ? [{ label: "Show", onClick: extra.onShow }] : []),
    ],
  });
}

export async function undoActivity(activityId: string): Promise<void> {
  useUi.getState().dropUndo(activityId);
  try {
    const undone = await rpc("activity.undo", { activityId });
    toast.show({ title: `Undone: ${undone.summary}`, duration: 3500 });
  } catch (error) {
    toast.error("Couldn't undo that", errorMessage(error));
  }
}

/** `z`: undo the newest change this session made that is still undoable. */
export async function undoLatest(): Promise<void> {
  const stack = useUi.getState().undoStack;
  const latest = stack[stack.length - 1];
  if (!latest) {
    toast.show({ title: "Nothing to undo", duration: 2500 });
    return;
  }
  await undoActivity(latest);
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const previous = queryClient.getQueryData<Bootstrap>(qk.bootstrap);
  if (previous) {
    queryClient.setQueryData<Bootstrap>(qk.bootstrap, { ...previous, settings: { ...previous.settings, ...patch } });
  }
  try {
    const settings = await rpc("settings.update", { patch });
    const current = queryClient.getQueryData<Bootstrap>(qk.bootstrap);
    if (current) queryClient.setQueryData<Bootstrap>(qk.bootstrap, { ...current, settings });
  } catch (error) {
    if (previous) queryClient.setQueryData(qk.bootstrap, previous);
    toast.error("Couldn't save that setting", errorMessage(error));
  }
}

/** Runs one call that changes something; on failure says what happened. */
export async function attempt<T>(work: () => Promise<T>, failure = "That didn't work"): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    toast.error(failure, errorMessage(error));
    return undefined;
  }
}

export function refreshBootstrap() {
  void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
}

// ── Accounts, groups and labels (patched in place, then confirmed) ──────────────────────────

function patchBootstrap(update: (b: Bootstrap) => Bootstrap): Bootstrap | undefined {
  const previous = queryClient.getQueryData<Bootstrap>(qk.bootstrap);
  if (previous) queryClient.setQueryData<Bootstrap>(qk.bootstrap, update(previous));
  return previous;
}

async function withPatch<T>(update: (b: Bootstrap) => Bootstrap, work: () => Promise<T>, failure: string): Promise<T | undefined> {
  const previous = patchBootstrap(update);
  try {
    const result = await work();
    refreshBootstrap();
    return result;
  } catch (error) {
    if (previous) queryClient.setQueryData(qk.bootstrap, previous);
    toast.error(failure, errorMessage(error));
    return undefined;
  }
}

export type AccountPatch = Omit<RpcParams<"accounts.update">, "accountId">;

export function updateAccount(accountId: string, patch: AccountPatch) {
  return withPatch(
    (b) => ({
      ...b,
      accounts: b.accounts.map((a) => {
        if (a.id !== accountId) return a;
        const { paused, ...rest } = patch;
        const next = { ...a, ...rest } as typeof a;
        if (paused !== undefined) next.status = { ...a.status, state: paused ? "paused" : "connecting" };
        return next;
      }),
    }),
    () => rpc("accounts.update", { accountId, ...patch }),
    "Couldn't change the account",
  );
}

export function updateGroup(groupId: string, patch: Omit<RpcParams<"groups.update">, "groupId">) {
  return withPatch(
    (b) => ({ ...b, groups: b.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)) }),
    () => rpc("groups.update", { groupId, ...patch }),
    "Couldn't change the group",
  );
}

export function updateLabel(labelId: string, patch: Omit<RpcParams<"labels.update">, "labelId">) {
  return withPatch(
    (b) => ({ ...b, labels: b.labels.map((l) => (l.id === labelId ? { ...l, ...patch } : l)) }),
    () => rpc("labels.update", { labelId, ...patch }),
    "Couldn't change the label",
  );
}

export function reorderGroups(groupIds: string[]) {
  return withPatch(
    (b) => ({ ...b, groups: b.groups.map((g) => ({ ...g, sortOrder: groupIds.indexOf(g.id) === -1 ? g.sortOrder : groupIds.indexOf(g.id) })) }),
    () => rpc("groups.reorder", { groupIds }),
    "Couldn't reorder the groups",
  );
}

export function reorderLabels(labelIds: string[]) {
  return withPatch(
    (b) => ({ ...b, labels: b.labels.map((l) => ({ ...l, sortOrder: labelIds.indexOf(l.id) === -1 ? l.sortOrder : labelIds.indexOf(l.id) })) }),
    () => rpc("labels.reorder", { labelIds }),
    "Couldn't reorder the labels",
  );
}

/** Order inside a group (or among ungrouped accounts), moving the accounts into it. */
export function reorderAccounts(accountIds: string[], groupId: string | null) {
  return withPatch(
    (b) => ({
      ...b,
      accounts: b.accounts.map((a) => {
        const index = accountIds.indexOf(a.id);
        return index === -1 ? a : { ...a, groupId, sortOrder: index };
      }),
    }),
    () => rpc("accounts.reorder", { accountIds, groupId }),
    "Couldn't move the account",
  );
}

export async function createGroup(name: string, color?: string) {
  const group = await attempt(() => rpc("groups.create", { name, ...(color ? { color } : {}) }), "Couldn't create the group");
  refreshBootstrap();
  return group;
}

export async function createLabel(name: string, color?: string | null) {
  const label = await attempt(() => rpc("labels.create", { name, color: color ?? null }), "Couldn't create the label");
  refreshBootstrap();
  return label;
}

export function syncNow(accountId?: string) {
  void attempt(() => rpc("accounts.syncNow", accountId ? { accountId } : {}), "Couldn't start syncing");
  toast.show({ id: "sync-now", title: accountId ? "Syncing this account" : "Syncing all accounts", duration: 2500 });
}
