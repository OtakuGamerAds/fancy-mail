/**
 * The keyboard, when focus is not in a field: Gmail's keys where they exist (c, /, j/k, e,
 * #, !, s, l, r/a/f, x, z, g then i/s/d/t/a, ?) plus T3 Code's Ctrl+K, Ctrl+B and Ctrl+,.
 * The same commands as the buttons (state/commands).
 */
import { useEffect } from "react";

import type { ViewKind } from "@fancy-mail/contracts";
import { toast } from "~/components/ui/toast";
import { isEditableTarget } from "~/lib/utils";
import { undoLatest } from "~/state/actions";
import { archiveOrInbox, runThreadCommand, targetThreadIds, toggleStar } from "~/state/commands";
import { indexOfThread, listNav } from "~/state/listNav";
import { navigate, navigateBackTo } from "~/state/router";
import { useUi } from "~/state/ui";

export interface Shortcut {
  keys: string[];
  label: string;
  group: "General" | "Navigation" | "Conversations";
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ["C"], label: "New message", group: "General" },
  { keys: ["Ctrl", "K"], label: "Search and commands", group: "General" },
  { keys: ["/"], label: "Search in this view", group: "General" },
  { keys: ["Z"], label: "Undo the last change", group: "General" },
  { keys: ["Ctrl", "B"], label: "Show or hide the sidebar", group: "General" },
  { keys: ["Ctrl", ","], label: "Settings", group: "General" },
  { keys: ["?"], label: "Keyboard shortcuts", group: "General" },
  { keys: ["J"], label: "Next conversation", group: "Navigation" },
  { keys: ["K"], label: "Previous conversation", group: "Navigation" },
  { keys: ["Enter"], label: "Open conversation (also O)", group: "Navigation" },
  { keys: ["Esc"], label: "Close conversation / clear selection", group: "Navigation" },
  { keys: ["G", "I"], label: "Go to Inbox", group: "Navigation" },
  { keys: ["G", "S"], label: "Go to Starred", group: "Navigation" },
  { keys: ["G", "D"], label: "Go to Drafts", group: "Navigation" },
  { keys: ["G", "T"], label: "Go to Trash", group: "Navigation" },
  { keys: ["G", "A"], label: "Go to All mail", group: "Navigation" },
  { keys: ["E"], label: "Archive", group: "Conversations" },
  { keys: ["Shift", "E"], label: "Move to inbox", group: "Conversations" },
  { keys: ["#"], label: "Trash (also Delete)", group: "Conversations" },
  { keys: ["!"], label: "Spam", group: "Conversations" },
  { keys: ["S"], label: "Star or unstar", group: "Conversations" },
  { keys: ["Shift", "U"], label: "Mark unread", group: "Conversations" },
  { keys: ["Shift", "I"], label: "Mark read", group: "Conversations" },
  { keys: ["L"], label: "Label", group: "Conversations" },
  { keys: ["R"], label: "Reply", group: "Conversations" },
  { keys: ["A"], label: "Reply all", group: "Conversations" },
  { keys: ["F"], label: "Forward", group: "Conversations" },
  { keys: ["X"], label: "Check or uncheck", group: "Conversations" },
  { keys: ["Ctrl", "A"], label: "Check all loaded", group: "Conversations" },
];

const GO_TO: Record<string, ViewKind> = { i: "inbox", s: "starred", d: "drafts", t: "trash", a: "all" };

function overlayOpen(): boolean {
  const ui = useUi.getState();
  if (ui.paletteOpen || ui.compose || ui.dialog || ui.labelPickerFor || ui.activitySheetOpen) return true;
  return !!document.querySelector(
    "[data-slot=menu-popup], [data-slot=popover-popup], [data-slot=select-popup], [data-slot=dialog-popup], [data-slot=alert-dialog-popup]",
  );
}

function moveFocus(delta: number) {
  const ui = useUi.getState();
  const threads = listNav.threads;
  if (threads.length === 0) return;
  const route = ui.route;
  const current = indexOfThread(ui.focusedThreadId ?? (route.page === "mail" ? route.threadId : null));
  const nextIndex = current === -1 ? 0 : Math.max(0, Math.min(threads.length - 1, current + delta));
  const next = threads[nextIndex]!;
  ui.setFocusedThread(next.id);
  listNav.scrollToIndex(nextIndex);
  if (route.page === "mail" && route.threadId && route.threadId !== next.id) {
    navigate({ ...route, threadId: next.id }, { replace: true });
  }
}

export function useKeyboard() {
  useEffect(() => {
    let pendingG = 0;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const ui = useUi.getState();
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key;

      // These work everywhere, even while typing.
      if (ctrl && !event.altKey && key.toLowerCase() === "k") {
        event.preventDefault();
        if (ui.paletteOpen) ui.closePalette();
        else ui.openPalette();
        return;
      }
      if (ctrl && key === ",") {
        event.preventDefault();
        navigate({ page: "settings", section: "accounts" });
        return;
      }
      if (ctrl && !event.shiftKey && key.toLowerCase() === "b" && !isEditableTarget(event.target)) {
        event.preventDefault();
        ui.toggleSidebar();
        return;
      }

      if (isEditableTarget(event.target) || overlayOpen()) return;
      if (event.altKey) return;

      const route = ui.route;
      const inMail = route.page === "mail";

      if (ctrl) {
        if (key.toLowerCase() === "a" && inMail) {
          event.preventDefault();
          ui.setSelection(listNav.threads.map((t) => t.id), listNav.threads[0]?.id ?? null);
        }
        return;
      }

      // g then a letter.
      if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        const kind = GO_TO[key.toLowerCase()];
        if (kind) {
          event.preventDefault();
          navigate({ page: "mail", view: { kind, scope: { type: "all" } }, threadId: null });
        }
        return;
      }

      const ids = () => targetThreadIds();

      switch (key) {
        case "g":
          pendingG = Date.now();
          return;
        case "c":
          event.preventDefault();
          ui.openCompose();
          return;
        case "/":
          if (!inMail) return;
          event.preventDefault();
          listNav.focusSearch();
          return;
        case "?":
          event.preventDefault();
          ui.openDialog({ type: "shortcuts" });
          return;
        case "z":
          event.preventDefault();
          void undoLatest();
          return;
        case "Escape":
          if (route.page === "settings" || route.page === "activity") {
            navigate({ page: "mail", view: { kind: "inbox", scope: { type: "all" } }, threadId: null });
            return;
          }
          if (ui.selection.length > 0) {
            ui.clearSelection();
            return;
          }
          if (inMail && route.threadId) {
            ui.setFocusedThread(route.threadId);
            navigateBackTo({ ...route, threadId: null });
          }
          return;
      }

      if (!inMail) return;

      switch (key) {
        case "j":
        case "ArrowDown":
          if (key === "ArrowDown" && route.threadId) return; // Let the reader scroll.
          event.preventDefault();
          moveFocus(1);
          return;
        case "k":
        case "ArrowUp":
          if (key === "ArrowUp" && route.threadId) return;
          event.preventDefault();
          moveFocus(-1);
          return;
        case "Enter":
        case "o": {
          const id = ui.focusedThreadId;
          if (!id) return;
          event.preventDefault();
          navigate({ ...route, threadId: id });
          return;
        }
        case "x": {
          const id = ui.focusedThreadId ?? route.threadId;
          if (!id) return;
          event.preventDefault();
          const has = ui.selection.includes(id);
          ui.setSelection(has ? ui.selection.filter((s) => s !== id) : [...ui.selection, id], id);
          return;
        }
        case "e":
          event.preventDefault();
          archiveOrInbox(ids());
          return;
        case "E":
          event.preventDefault();
          void runThreadCommand("moveToInbox", ids());
          return;
        case "#":
        case "Delete":
          event.preventDefault();
          void runThreadCommand("trash", ids());
          return;
        case "!":
          event.preventDefault();
          void runThreadCommand("markSpam", ids());
          return;
        case "s":
          event.preventDefault();
          toggleStar(ids());
          return;
        case "U":
          event.preventDefault();
          void runThreadCommand("markUnread", ids());
          return;
        case "I":
          event.preventDefault();
          void runThreadCommand("markRead", ids());
          return;
        case "l": {
          const targets = ids();
          if (targets.length === 0) return;
          event.preventDefault();
          ui.openLabelPicker(targets);
          return;
        }
        case "r":
        case "a":
        case "f": {
          event.preventDefault();
          const threadId = route.threadId ?? ui.focusedThreadId;
          if (!threadId) {
            toast.show({ title: "Open a conversation to reply", duration: 2000 });
            return;
          }
          if (!route.threadId) navigate({ ...route, threadId });
          ui.requestReply(threadId, key === "r" ? "reply" : key === "a" ? "replyAll" : "forward");
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
