/**
 * What the current view is called and which query it runs. A view is a query (contracts'
 * viewQuery); the sidebar's search and the filter chip are added to it.
 */
import { VIEW_TITLES, scopeQuery, viewQuery, type Bootstrap, type ViewScope } from "@fancy-mail/contracts";

import { directoryOf } from "./queries";
import { toMailView, viewScope, type ViewRef } from "./router";
import type { ListFilter } from "./ui";

export interface ViewInfo {
  title: string;
  /** "Banking" or "Billing" next to the title for a scoped view. */
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

export function scopeLabel(scope: ViewScope, bootstrap: Bootstrap | undefined): string | null {
  const dir = directoryOf(bootstrap);
  if (scope.type === "group") return dir.groupById.get(scope.groupId)?.name ?? "Group";
  if (scope.type === "account") {
    const account = dir.accountById.get(scope.accountId);
    return account ? account.displayName || account.email : "Account";
  }
  return null;
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
      if (view.kind === "inbox" && scope.type !== "all") {
        // "Banking", "billing@brightwave.example": the scope is the title of its inbox.
        title = chip ?? "Inbox";
        chip = null;
      } else {
        title = VIEW_TITLES[view.kind];
      }
  }

  let accountsInScope = dir.accounts;
  if (scope.type === "group") accountsInScope = dir.accounts.filter((a) => a.groupId === scope.groupId);
  if (scope.type === "account") accountsInScope = dir.accounts.filter((a) => a.id === scope.accountId);

  let defaultAccountId: string | null = null;
  if (scope.type === "account") defaultAccountId = scope.accountId;
  else defaultAccountId = accountsInScope[0]?.id ?? dir.accounts[0]?.id ?? null;

  return {
    title,
    scopeLabel: chip,
    query,
    scope,
    spansAccounts: scope.type !== "account" && dir.accounts.length > 1,
    defaultAccountId,
  };
}

/**
 * The list's query. A search from an inbox looks through all the mail of that scope (archived
 * mail included, as a search should); any other view (Sent, a label, a folder) is narrowed.
 */
export function listQuery(view: ViewRef, info: ViewInfo, search: string, filter: ListFilter): string | null {
  if (info.query === null) return null;
  const text = search.trim();
  const base = text && searchWidens(view) ? scopeQuery(info.scope) : info.query;
  return [base, text, FILTER_QUERY[filter]].filter(Boolean).join(" ");
}

/** Searching from this view looks through all mail in its scope. */
export function searchWidens(view: ViewRef): boolean {
  return view.kind === "inbox";
}
