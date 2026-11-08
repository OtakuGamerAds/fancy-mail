/**
 * Views are what the sidebar shows: "Inbox" across everything, a group's inbox, one account's
 * Sent folder, a label. Each view is nothing more than a query, so the list, the counts and
 * an agent asking the same question all agree.
 */
import { quoteQueryValue } from "./query.ts";

export type ViewScope =
  | { type: "all" }
  | { type: "group"; groupId: string }
  | { type: "account"; accountId: string };

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
  if (a.type !== b.type) return false;
  if (a.type === "group" && b.type === "group") return a.groupId === b.groupId;
  if (a.type === "account" && b.type === "account") return a.accountId === b.accountId;
  return true;
}

export function sameView(a: MailView, b: MailView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "mailbox" && b.kind === "mailbox") return a.mailboxId === b.mailboxId;
  if (a.kind === "label" && b.kind === "label") return a.labelId === b.labelId && sameScope(a.scope, b.scope);
  if (a.kind === "search" && b.kind === "search") return a.query === b.query && sameScope(a.scope, b.scope);
  if ("scope" in a && "scope" in b) return sameScope(a.scope, b.scope);
  return false;
}
