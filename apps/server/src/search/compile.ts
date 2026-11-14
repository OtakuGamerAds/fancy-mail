/**
 * The search language (parsed by contracts/query.ts) → one SQL condition over `threads t`.
 * Words go through the FTS5 index; everything else uses the denormalized thread flags.
 *
 * Unknown labels, accounts and groups are reported in `errors` and make the query match
 * nothing, so an agent sees what exists instead of a silently wrong answer.
 */
import { findStateLabel } from "@fancy-mail/contracts";
import type { FieldKey, ParsedQuery, QueryTerm } from "@fancy-mail/contracts";

import type { SqlValue } from "../db/sqlite.ts";

export interface CompileLookups {
  labels: { id: string; name: string }[];
  accounts: { id: string; email: string; displayName: string; groupId: string | null }[];
  groups: { id: string; name: string }[];
}

export interface CompileOptions {
  /** Agents: only these accounts exist (the others are hidden from them). */
  visibleAccountIds?: string[];
  /**
   * Check the word match per conversation while walking the list in date order, instead of
   * looking up every matching conversation. Faster for a page when the words match a lot of
   * mail (the caller decides from the hit count); slower for counting.
   */
  textScan?: boolean;
}

export interface CompiledQuery {
  where: string;
  params: SqlValue[];
  errors: string[];
  /** The FTS5 expression of the positive words, if any (to estimate how much they match). */
  match: string | null;
}

const NOTHING = "0";
const LIVE = "(t.live_count > 0 OR t.draft_count > 0)";
const LIST_LIMIT = 12;

/** FTS5 column per field. */
const FIELD_COLUMNS: Record<FieldKey, string> = {
  from: "sender",
  to: "recipients",
  cc: "cc",
  subject: "subject",
  filename: "attachments",
};

/** The words FTS5 sees in a string (unicode61 splits on everything but letters and digits). */
export function ftsTokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/** One FTS5 phrase from free text: `"a b c"`, with a trailing `*` when the last word is a prefix. */
export function ftsPhrase(value: string, prefix: boolean): string | null {
  const tokens = ftsTokens(value);
  if (tokens.length === 0) return null;
  return `"${tokens.join(" ")}"${prefix ? " *" : ""}`;
}

function listNames(names: string[]): string {
  const shown = names.slice(0, LIST_LIMIT);
  const more = names.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

function lower(s: string): string {
  return s.trim().toLocaleLowerCase();
}

const FTS_SUBQUERY =
  "SELECT m.thread_id FROM message_fts JOIN messages m ON m.seq = message_fts.rowid WHERE message_fts MATCH ?";

export function compileQuery(parsed: ParsedQuery, lookups: CompileLookups, options: CompileOptions = {}): CompiledQuery {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const errors: string[] = [];

  const visible = options.visibleAccountIds ? new Set(options.visibleAccountIds) : null;
  const accounts = visible ? lookups.accounts.filter((a) => visible.has(a.id)) : lookups.accounts;

  const add = (sql: string, ...values: SqlValue[]) => {
    clauses.push(sql);
    params.push(...values);
  };
  const addTerm = (negated: boolean, sql: string, ...values: SqlValue[]) => add(negated ? `NOT (${sql})` : sql, ...values);

  // Words: all positive text and field terms go into one MATCH (they must hold for one message).
  const positiveMatch: string[] = [];
  const texts = parsed.terms.filter((t): t is Extract<QueryTerm, { kind: "text" }> => t.kind === "text");
  const lastPositiveText = [...texts].reverse().find((t) => !t.negated);

  // OR-groups: several positive thread: terms widen the search, and so do account: and group:
  // terms, together (group:Banking account:me@x.com is Banking's mail and that account's).
  const threadIds: string[] = [];
  const scopeIds: string[] = [];
  let hasScope = false;
  let hasLocation = false;

  for (const term of parsed.terms) {
    switch (term.kind) {
      case "text": {
        // The last word typed is still being typed: match it as a prefix ("invoi" → invoice).
        const tokens = ftsTokens(term.value);
        const phrase = ftsPhrase(term.value, term === lastPositiveText && tokens.length === 1 && !/\s/.test(term.value));
        if (!phrase) break;
        if (term.negated) addTerm(true, `t.id IN (${FTS_SUBQUERY})`, phrase);
        else positiveMatch.push(phrase);
        break;
      }
      case "field": {
        const phrase = ftsPhrase(term.value, true);
        if (!phrase) {
          errors.push(`${term.field}:${term.value} has no letters or digits to search for.`);
          break;
        }
        const expr = `${FIELD_COLUMNS[term.field]} : (${phrase})`;
        if (term.negated) addTerm(true, `t.id IN (${FTS_SUBQUERY})`, expr);
        else positiveMatch.push(expr);
        break;
      }
      case "is": {
        if (term.value === "settled" || term.value === "unsettled" || term.value === "waiting" || term.value === "snoozed" || term.value === "pinned") {
          // Where it stands: carries that state's label (none yet: nothing is in that state).
          const key = term.value === "unsettled" ? "settled" : term.value;
          const label = findStateLabel(lookups.labels, key);
          const sql = label ? "t.id IN (SELECT tl.thread_id FROM thread_labels tl WHERE tl.label_id = ?)" : NOTHING;
          addTerm(term.negated !== (term.value === "unsettled"), sql, ...(label ? [label.id] : []));
          break;
        }
        const sql = {
          unread: "t.unread_count > 0",
          read: "t.unread_count = 0",
          starred: "t.starred = 1",
          unstarred: "t.starred = 0",
          draft: "(t.draft_count > 0 OR t.in_drafts = 1)",
        }[term.value as "unread" | "read" | "starred" | "unstarred" | "draft"];
        addTerm(term.negated, sql);
        break;
      }
      case "has":
        addTerm(
          term.negated,
          term.value === "summary" ? "EXISTS (SELECT 1 FROM thread_summaries s WHERE s.thread_id = t.id)" : "t.has_attachments = 1",
        );
        break;
      case "in": {
        if (!term.negated) hasLocation = true;
        const sql = {
          inbox: "t.in_inbox = 1",
          sent: "t.in_sent = 1",
          drafts: "(t.draft_count > 0 OR t.in_drafts = 1)",
          trash: "t.in_trash = 1",
          spam: "t.in_spam = 1",
          archive: "t.in_archive = 1",
          starred: "(t.starred = 1 AND t.live_count > 0)",
          all: LIVE,
          anywhere: "1",
        }[term.value];
        addTerm(term.negated, sql);
        break;
      }
      case "category":
        // Mail Gmail didn't sort (other providers, not asked yet) is primary.
        if (term.value === "primary") addTerm(term.negated, "(t.category IS NULL OR t.category = 'primary')");
        else addTerm(term.negated, "t.category IS ?", term.value);
        break;
      case "label": {
        const value = lower(term.value);
        if (value === "none") {
          addTerm(term.negated, "t.id NOT IN (SELECT tl.thread_id FROM thread_labels tl)");
          break;
        }
        const findLabel = (raw: string) => lookups.labels.find((l) => l.id === raw.trim()) ?? lookups.labels.find((l) => lower(l.name) === lower(raw));
        // label:Invoices,Receipts — any of them (unless a label is named exactly that).
        const parts = findLabel(term.value) ? [term.value] : term.value.split(",").filter((p) => p.trim());
        const found = parts.map((raw) => ({ raw, label: findLabel(raw) }));
        const missing = found.filter((f) => !f.label);
        if (found.length === 0 || missing.length > 0) {
          const name = missing[0]?.raw ?? term.value;
          errors.push(
            lookups.labels.length > 0
              ? `No label named "${name}". Labels: ${listNames(lookups.labels.map((l) => l.name))}.`
              : `No label named "${name}". There are no labels yet.`,
          );
          add(NOTHING);
          break;
        }
        const ids = [...new Set(found.map((f) => f.label!.id))];
        addTerm(term.negated, `t.id IN (SELECT tl.thread_id FROM thread_labels tl WHERE tl.label_id IN (${marks(ids.length)}))`, ...ids);
        break;
      }
      case "account": {
        const value = lower(term.value);
        const matches = accounts.filter(
          (a) => a.id === term.value.trim() || lower(a.email) === value || lower(a.displayName) === value,
        );
        if (matches.length === 0) {
          errors.push(
            accounts.length > 0
              ? `No account "${term.value}". Accounts: ${listNames(accounts.map((a) => a.email))}.`
              : `No account "${term.value}". There are no accounts yet.`,
          );
          add(NOTHING);
          break;
        }
        const ids = matches.map((a) => a.id);
        if (term.negated) addTerm(true, `t.account_id IN (${marks(ids.length)})`, ...ids);
        else {
          hasScope = true;
          scopeIds.push(...ids);
        }
        break;
      }
      case "group": {
        const value = lower(term.value);
        let ids: string[];
        if (value === "none") {
          ids = accounts.filter((a) => a.groupId === null).map((a) => a.id);
        } else {
          const group =
            lookups.groups.find((g) => g.id === term.value.trim()) ?? lookups.groups.find((g) => lower(g.name) === value);
          if (!group) {
            errors.push(
              lookups.groups.length > 0
                ? `No group "${term.value}". Groups: ${listNames(lookups.groups.map((g) => g.name))}, or group:none.`
                : `No group "${term.value}". There are no groups yet.`,
            );
            add(NOTHING);
            break;
          }
          ids = accounts.filter((a) => a.groupId === group.id).map((a) => a.id);
        }
        if (term.negated) {
          addTerm(true, ids.length > 0 ? `t.account_id IN (${marks(ids.length)})` : NOTHING, ...ids);
        } else {
          hasScope = true;
          scopeIds.push(...ids);
        }
        break;
      }
      case "date":
        // A conversation matches when one of its messages is in range.
        if (term.op === "after") add("t.last_message_at >= ?", term.at);
        else add("t.first_message_at < ?", term.at);
        break;
      case "size":
        add(
          `EXISTS (SELECT 1 FROM messages ms WHERE ms.thread_id = t.id AND ms.size ${term.op === "larger" ? ">" : "<"} ?)`,
          term.bytes,
        );
        break;
      case "thread":
        if (term.negated) addTerm(true, "t.id = ?", term.value.trim());
        else threadIds.push(term.value.trim());
        break;
      case "mailbox": {
        const value = term.value.trim();
        const sql = `EXISTS (SELECT 1 FROM messages mm_m JOIN message_mailboxes mm ON mm.message_id = mm_m.id
                       JOIN mailboxes b ON b.id = mm.mailbox_id
                      WHERE mm_m.thread_id = t.id AND (b.path = ? OR (upper(?) = 'INBOX' AND upper(b.path) = 'INBOX')))`;
        addTerm(term.negated, sql, value, value);
        break;
      }
    }
  }

  const match = positiveMatch.length > 0 ? positiveMatch.join(" AND ") : null;
  if (match) add(`${options.textScan ? "+t.id" : "t.id"} IN (${FTS_SUBQUERY})`, match);
  if (threadIds.length > 0) add(`t.id IN (${marks(threadIds.length)})`, ...threadIds);
  if (hasScope) {
    const ids = [...new Set(scopeIds)];
    add(ids.length > 0 ? `t.account_id IN (${marks(ids.length)})` : NOTHING, ...ids);
  }
  if (!hasLocation) add(LIVE);
  if (visible) {
    const ids = [...visible];
    add(ids.length > 0 ? `t.account_id IN (${marks(ids.length)})` : NOTHING, ...ids);
  }

  return { where: clauses.length > 0 ? clauses.join(" AND ") : "1", params, errors, match };
}

function marks(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/** Cursor for the next page: base64url of `${lastMessageAt}:${id}`. */
export function encodeCursor(at: number, id: string): string {
  return Buffer.from(`${at}:${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { at: number; id: string } | null {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const index = text.indexOf(":");
    if (index <= 0) return null;
    const at = Number(text.slice(0, index));
    const id = text.slice(index + 1);
    if (!Number.isFinite(at) || !id) return null;
    return { at, id };
  } catch {
    return null;
  }
}
