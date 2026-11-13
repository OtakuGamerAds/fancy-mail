/**
 * Where the mail views look. Groups and accounts in the sidebar pick the place (one, several
 * with Ctrl+click, or All accounts); Mail's views and the labels pick what to show there.
 */
import { toggleScopeItem, VIEW_KINDS, type ScopeItem, type ViewKind, type ViewScope } from "@fancy-mail/contracts";

import { IS_MAC, isModKey } from "~/lib/keys";
import { navigate, type ViewRef } from "./router";
import { useUi } from "./ui";

/** "Ctrl+click", or "Cmd+click" on a Mac. */
export const MULTI_CLICK = IS_MAC ? "⌘-click" : "Ctrl+click";

/** Where the mail views look (the last mail page's scope, kept while in Settings). */
export function useScope(): ViewScope {
  return useUi((s) => s.scope);
}

export function currentScope(): ViewScope {
  return useUi.getState().scope;
}

function go(view: ViewRef) {
  navigate({ page: "mail", view, threadId: null });
}

/**
 * Looks somewhere else and keeps what you were looking at: Starred in Banking becomes Starred
 * in Studio, a label stays that label. Folders and searches go to the inbox.
 */
export function goScope(scope: ViewScope) {
  const route = useUi.getState().route;
  const view = route.page === "mail" ? route.view : null;
  if (view?.kind === "label") return go({ kind: "label", labelId: view.labelId, scope });
  if (view && (VIEW_KINDS as readonly string[]).includes(view.kind)) return go({ kind: view.kind as ViewKind, scope });
  go({ kind: "inbox", scope });
}

/** A click looks at just this group or account; Ctrl+click (Cmd on a Mac) adds or removes it. */
export function pickScope(item: ScopeItem, event: { ctrlKey: boolean; metaKey: boolean }) {
  const alone: ViewScope = item.type === "group" ? { type: "group", groupId: item.id } : { type: "account", accountId: item.id };
  goScope(isModKey(event) ? toggleScopeItem(currentScope(), item) : alone);
}

/** Adds the item to where the views look, or takes it out. */
export function toggleInScope(item: ScopeItem) {
  goScope(toggleScopeItem(currentScope(), item));
}
