/**
 * What the current view is called and which query it runs. A view is a query (contracts'
 * viewQuery); the sidebar's search and the filter chip are added to it.
 */
import { VIEW_TITLES, scopeItems, scopeQuery, viewQuery, type Account, type Bootstrap, type InboxTab, type ViewScope } from "@fancy-mail/contracts";

import { directoryOf, type Directory } from "./queries";
import { toMailView, viewScope, type ViewRef } from "./router";
import type { InboxTabId, ListFilter } from "./ui";

export interface ViewInfo {
  title: string;
  /** "Banking", "Billing" or "Banking + Studio" next to the title for a scoped view. */
  scopeLabel: string | null;
  /** The view's own query, or null while its folder is unknown. */
  query: string | null;
  scope: ViewScope;
  /** More than one account may show up, so rows show the account dot. */
  spansAccounts: boolean;
  /** The account a new message starts from. */
  defaultAccountId: string | null;
}

export const FILTER_QUERY: Record<ListFilter, string> = {
  all: "",
  unread: "is:unread",
  starred: "is:starred",
  attachments: "has:attachment",
};

/** The accounts a scope covers (a group's, an account, several together, or all). */
export function scopeAccounts(scope: ViewScope, dir: Directory): Account[] {
  if (scope.type === "all") return dir.accounts;
  const groups = new Set<string>();
  const accounts = new Set<string>();
  for (const item of scopeItems(scope)) (item.type === "group" ? groups : accounts).add(item.id);
  return dir.accounts.filter((a) => accounts.has(a.id) || (a.groupId !== null && groups.has(a.groupId)));
}

export function inScope(accountId: string, scope: ViewScope, dir: Directory): boolean {
  return scopeAccounts(scope, dir).some((a) => a.id === accountId);
}

export function scopeLabel(scope: ViewScope, bootstrap: Bootstrap | undefined): string | null {
  const dir = directoryOf(bootstrap);
  const names = scopeItems(scope).map((item) => {
    if (item.type === "group") return dir.groupById.get(item.id)?.name ?? "Group";
    const account = dir.accountById.get(item.id);
    return account ? account.displayName || account.email : "Account";
  });
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(" + ");
  return `${names[0]} + ${names.length - 1} more`;
}

export function describeView(view: ViewRef, bootstrap: Bootstrap | undefined): ViewInfo {
  const dir = directoryOf(bootstrap);
  const scope = viewScope(view);
  const mailView = toMailView(view, bootstrap);
  const query = mailView ? viewQuery(mailView) : null;

  let title: string;
  let chip: string | null = scopeLabel(scope, bootstrap);
  switch (view.kind) {
    case "label":
      title = dir.labelById.get(view.labelId)?.name ?? "Label";
      break;
    case "mailbox":
      title = bootstrap?.mailboxes.find((m) => m.id === view.mailboxId)?.name ?? "Folder";
      break;
    case "search":
      title = "Search";
      break;
    default:
      // "Inbox" and the scope beside it, as with every other view: the scope is where you
      // look, the view is what.
      title = VIEW_TITLES[view.kind];
  }
  // A folder belongs to its account; the account is in its name already.
  if (view.kind === "mailbox") chip = null;

  const accountsInScope = scopeAccounts(scope, dir);

  let defaultAccountId: string | null = null;
  if (scope.type === "account") defaultAccountId = scope.accountId;
  else defaultAccountId = accountsInScope[0]?.id ?? dir.accounts[0]?.id ?? null;

  return {
    title,
    scopeLabel: chip,
    query,
    scope,
    spansAccounts: accountsInScope.length > 1,
    defaultAccountId,
  };
}

/**
 * The list's query. A search from an inbox looks through all the mail of that scope (archived
 * mail included, as a search should); any other view (Sent, a label, a folder) is narrowed.
 */
export function listQuery(view: ViewRef, info: ViewInfo, search: string, filter: ListFilter, tab: string = ""): string | null {
  if (info.query === null) return null;
  const text = search.trim();
  const base = text && searchWidens(view) ? scopeQuery(info.scope) : info.query;
  return [base, text ? "" : tab, text, FILTER_QUERY[filter]].filter(Boolean).join(" ");
}

/**
 * An inbox tab's part of the query. Primary is what no shown tab takes: with Updates hidden,
 * updates stay in Primary, as in Gmail.
 */
export function inboxTabQuery(tab: InboxTabId, shown: readonly InboxTab[]): string {
  if (tab === "primary") return shown.map((t) => `-category:${t}`).join(" ");
  return `category:${tab}`;
}

/** Searching from this view looks through all mail in its scope. */
export function searchWidens(view: ViewRef): boolean {
  return view.kind === "inbox";
}
