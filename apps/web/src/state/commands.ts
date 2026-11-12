/**
 * The conversation commands every door shares: the row's hover buttons, the bulk bar, the
 * reader toolbar, the keyboard and the palette. Commands that take a conversation out of the
 * current view move the reader on to the next one.
 */
import type { ModifyAction, ThreadSummary } from "@fancy-mail/contracts";

import { modifyThreads } from "./actions";
import { listNav, neighborAfterRemoving } from "./listNav";
import { directoryOf, findCachedThread, qk, queryClient } from "./queries";
import { navigate } from "./router";
import { useUi } from "./ui";
import { splitsSettled } from "./view";

export type ThreadCommand =
  | "archive"
  | "moveToInbox"
  | "trash"
  | "restore"
  | "markSpam"
  | "notSpam"
  | "markRead"
  | "markUnread"
  | "star"
  | "unstar"
  | "settle"
  | "unsettle"
  | "unwait"
  | "unsnooze"
  | "pin"
  | "unpin";

const LEAVES_VIEW: Partial<Record<ThreadCommand, true>> = {
  archive: true,
  trash: true,
  restore: true,
  markSpam: true,
  notSpam: true,
  moveToInbox: true,
  settle: true,
};

/** Commands that take a time (when it comes back). */
export type TimedCommand = "wait" | "snooze";

/** Whether the command removes the conversation from what the person is looking at. */
function leavesCurrentView(command: ThreadCommand | TimedCommand): boolean {
  if (command !== "wait" && command !== "snooze" && !LEAVES_VIEW[command]) return false;
  const route = useUi.getState().route;
  if (route.page !== "mail") return false;
  const kind = route.view.kind;
  if (command === "settle" || command === "wait" || command === "snooze") return splitsSettled(route.view, useUi.getState().search);
  if (command === "moveToInbox") return kind === "archive";
  if (command === "archive") return kind === "inbox" || kind === "unread";
  if (command === "restore") return kind === "trash";
  if (command === "notSpam") return kind === "spam";
  return true;
}

export async function runThreadCommand(command: ThreadCommand, threadIds: string[]) {
  return runThreadAction({ type: command } as ModifyAction, threadIds);
}

/** Waits for an answer, or snoozes, until then: out of the active list. */
export function runTimedCommand(command: TimedCommand, threadIds: string[], until: number) {
  return runThreadAction({ type: command, until }, threadIds);
}

async function runThreadAction(action: ModifyAction, threadIds: string[]) {
  const command = action.type as ThreadCommand | TimedCommand;
  if (threadIds.length === 0) return;
  const ui = useUi.getState();
  const route = ui.route;
  const openId = route.page === "mail" ? route.threadId : null;

  if (route.page === "mail" && leavesCurrentView(command)) {
    // Move the reader and the keyboard focus on before the rows disappear (after settling, to
    // the next one that isn't settled).
    const skip = command === "settle" || command === "wait" || command === "snooze" ? notActive() : undefined;
    if (openId && threadIds.includes(openId)) {
      const next = neighborAfterRemoving(threadIds, openId, skip);
      navigate({ ...route, threadId: next }, { replace: true });
    }
    if (ui.focusedThreadId && threadIds.includes(ui.focusedThreadId)) {
      ui.setFocusedThread(neighborAfterRemoving(threadIds, ui.focusedThreadId, skip));
    }
    ui.setSelection(ui.selection.filter((id) => !threadIds.includes(id)));
  }
  await modifyThreads(threadIds, [action]);
}

/** Rows that aren't a good next stop after settling, waiting or snoozing: not active ones. */
function notActive(): (t: ThreadSummary) => boolean {
  const ids = directoryOf(queryClient.getQueryData(qk.bootstrap)).stateLabelIds;
  const off = [ids.settled, ids.waiting, ids.snoozed].filter((id): id is string => !!id);
  return (t) => t.labelIds.some((id) => off.includes(id));
}

/** Where a conversation stands, from its labels. */
export type ThreadState = "active" | "pinned" | "waiting" | "snoozed" | "settled";

export function threadState(thread: Pick<ThreadSummary, "labelIds">, ids: Partial<Record<"settled" | "waiting" | "snoozed" | "pinned", string>>): ThreadState {
  const has = (id: string | undefined) => !!id && thread.labelIds.includes(id);
  if (has(ids.snoozed)) return "snoozed";
  if (has(ids.waiting)) return "waiting";
  if (has(ids.settled)) return "settled";
  if (has(ids.pinned)) return "pinned";
  return "active";
}

/** Pin all, unless all are pinned already (then unpin). */
export function togglePin(ids: string[]) {
  const pinnedId = directoryOf(queryClient.getQueryData(qk.bootstrap)).stateLabelIds.pinned ?? null;
  const list = summaries(ids);
  const allPinned = pinnedId !== null && list.length > 0 && list.every((t) => t.labelIds.includes(pinnedId));
  void runThreadCommand(allPinned ? "unpin" : "pin", ids);
}

function summaries(ids: string[]): ThreadSummary[] {
  const byId = new Map(listNav.threads.map((t) => [t.id, t]));
  return ids.map((id) => byId.get(id) ?? findCachedThread(id)).filter((t): t is ThreadSummary => !!t);
}

/** Star all, unless all are starred already (then unstar). */
export function toggleStar(ids: string[]) {
  const list = summaries(ids);
  const allStarred = list.length > 0 && list.every((t) => t.starred);
  void runThreadCommand(allStarred ? "unstar" : "star", ids);
}

/** Whether a conversation carries the Settled label. */
export function isSettled(thread: Pick<ThreadSummary, "labelIds">, settledLabelId: string | null): boolean {
  return settledLabelId !== null && thread.labelIds.includes(settledLabelId);
}

/** Settle all, unless all are settled already (then un-settle). */
export function toggleSettle(ids: string[]) {
  const settledId = directoryOf(queryClient.getQueryData(qk.bootstrap)).settledLabelId;
  const list = summaries(ids);
  const allSettled = list.length > 0 && list.every((t) => isSettled(t, settledId));
  void runThreadCommand(allSettled ? "unsettle" : "settle", ids);
}

/** Mark read, unless all are read already (then unread). */
export function toggleRead(ids: string[]) {
  const list = summaries(ids);
  const anyUnread = list.some((t) => t.unreadCount > 0);
  void runThreadCommand(anyUnread ? "markRead" : "markUnread", ids);
}

/** Archive, or back to the inbox when it is not in the inbox. */
export function archiveOrInbox(ids: string[]) {
  const list = summaries(ids);
  const allOut = list.length > 0 && list.every((t) => !t.inInbox && !t.inTrash && !t.inSpam);
  void runThreadCommand(allOut ? "moveToInbox" : "archive", ids);
}

export function trashOrRestore(ids: string[]) {
  const list = summaries(ids);
  const allTrashed = list.length > 0 && list.every((t) => t.inTrash);
  void runThreadCommand(allTrashed ? "restore" : "trash", ids);
}

export function spamOrNot(ids: string[]) {
  const list = summaries(ids);
  const allSpam = list.length > 0 && list.every((t) => t.inSpam);
  void runThreadCommand(allSpam ? "notSpam" : "markSpam", ids);
}

/** What keyboard and toolbar commands act on: the checked rows, else the open or focused one. */
export function targetThreadIds(): string[] {
  const ui = useUi.getState();
  if (ui.selection.length > 0) return ui.selection;
  const route = ui.route;
  if (route.page === "mail" && route.threadId && (ui.focusZone === "reader" || !ui.focusedThreadId)) return [route.threadId];
  if (ui.focusedThreadId) return [ui.focusedThreadId];
  if (route.page === "mail" && route.threadId) return [route.threadId];
  return [];
}
