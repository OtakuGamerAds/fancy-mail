/**
 * Views are what the sidebar shows: "Inbox" across everything, a group's inbox, one account's
 * Sent folder, a label. Each view is nothing more than a query, so the list, the counts and
 * an agent asking the same question all agree.
 */
import { quoteQueryValue } from "./query.ts";

/**
 * Where a view looks: everything, one group, one account, or several groups and accounts
 * together (`set`, always two or more: see normalizeScope).
 */
export type ViewScope =
  | { type: "all" }
  | { type: "group"; groupId: string }
  | { type: "account"; accountId: string }
  | { type: "set"; groupIds: string[]; accountIds: string[] };

export type ScopeItem = { type: "group"; id: string } | { type: "account"; id: string };

/**
 * "Ungrouped" (the accounts in no group) is a group to the views: its id is the search's
 * group:none, so it opens, counts and combines like any group. No real group can be named or
 * numbered "none".
 */
export const UNGROUPED_ID = "none";

export function scopeItems(scope: ViewScope): ScopeItem[] {
  switch (scope.type) {
    case "all":
      return [];
    case "group":
      return [{ type: "group", id: scope.groupId }];
    case "account":
      return [{ type: "account", id: scope.accountId }];
    case "set":
      return [...scope.groupIds.map((id) => ({ type: "group" as const, id })), ...scope.accountIds.map((id) => ({ type: "account" as const, id }))];
  }
}

/** The scope of these items: none is everything, one is that group or account. */
export function scopeOf(items: ScopeItem[]): ViewScope {
  const groupIds = [...new Set(items.filter((i) => i.type === "group").map((i) => i.id))];
  const accountIds = [...new Set(items.filter((i) => i.type === "account").map((i) => i.id))];
  if (groupIds.length + accountIds.length === 0) return { type: "all" };
  if (groupIds.length === 1 && accountIds.length === 0) return { type: "group", groupId: groupIds[0]! };
  if (accountIds.length === 1 && groupIds.length === 0) return { type: "account", accountId: accountIds[0]! };
  return { type: "set", groupIds, accountIds };
}

export function scopeHas(scope: ViewScope, item: ScopeItem): boolean {
  return scopeItems(scope).some((i) => i.type === item.type && i.id === item.id);
}

/** Adds the item to the scope, or takes it out (everything, when it was the last). */
export function toggleScopeItem(scope: ViewScope, item: ScopeItem): ViewScope {
  const items = scopeItems(scope);
  return scopeHas(scope, item) ? scopeOf(items.filter((i) => !(i.type === item.type && i.id === item.id))) : scopeOf([...items, item]);
}

export const VIEW_KINDS = [
  "inbox",
  "unread",
  "starred",
  "drafts",
  "sent",
  "archive",
  "all",
  "attachments",
  "spam",
  "trash",
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export type MailView =
  | { kind: ViewKind; scope: ViewScope }
  | { kind: "label"; labelId: string; scope: ViewScope }
  | { kind: "mailbox"; accountId: string; mailboxId: string; path: string }
  | { kind: "search"; query: string; scope: ViewScope };

export const VIEW_TITLES: Record<ViewKind, string> = {
  inbox: "Inbox",
  unread: "Unread",
  starred: "Starred",
  drafts: "Drafts",
  sent: "Sent",
  archive: "Archive",
  all: "All mail",
  attachments: "Attachments",
  spam: "Spam",
  trash: "Trash",
};

const KIND_QUERY: Record<ViewKind, string> = {
  inbox: "in:inbox",
  unread: "is:unread in:inbox",
  starred: "in:starred",
  drafts: "in:drafts",
  sent: "in:sent",
  archive: "in:archive",
  all: "in:all",
  attachments: "has:attachment",
  spam: "in:spam",
  trash: "in:trash",
};

export function scopeQuery(scope: ViewScope): string {
  switch (scope.type) {
    case "all":
      return "";
    case "group":
      return `group:${scope.groupId}`;
    case "account":
      return `account:${scope.accountId}`;
    case "set":
      // Several group: and account: terms widen each other (any of them).
      return [...scope.groupIds.map((id) => `group:${id}`), ...scope.accountIds.map((id) => `account:${id}`)].join(" ");
  }
}

/** The query a view runs. Ids are used for scopes and labels so renames never break a view. */
export function viewQuery(view: MailView): string {
  switch (view.kind) {
    case "label":
      return [`label:${view.labelId}`, scopeQuery(view.scope)].filter(Boolean).join(" ");
    case "mailbox":
      return `account:${view.accountId} in:anywhere mailbox:${quoteQueryValue(view.path)}`;
    case "search":
      return [view.query.trim(), scopeQuery(view.scope)].filter(Boolean).join(" ");
    default:
      return [KIND_QUERY[view.kind], scopeQuery(view.scope)].filter(Boolean).join(" ");
  }
}

export function sameScope(a: ViewScope, b: ViewScope): boolean {
  const key = (s: ViewScope) => scopeItems(s).map((i) => `${i.type}:${i.id}`).sort().join(" ");
  return a.type === b.type && key(a) === key(b);
}

export function sameView(a: MailView, b: MailView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "mailbox" && b.kind === "mailbox") return a.mailboxId === b.mailboxId;
  if (a.kind === "label" && b.kind === "label") return a.labelId === b.labelId && sameScope(a.scope, b.scope);
  if (a.kind === "search" && b.kind === "search") return a.query === b.query && sameScope(a.scope, b.scope);
  if ("scope" in a && "scope" in b) return sameScope(a.scope, b.scope);
  return false;
}
