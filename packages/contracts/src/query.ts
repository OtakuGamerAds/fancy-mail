/**
 * The search language. One syntax, close to Gmail's, used by the search box, by every view in
 * the sidebar (a view is just a query) and by the MCP tools. The server compiles the parsed
 * terms to SQL; nothing else interprets a query string.
 */

export const IN_VALUES = [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "spam",
  "archive",
  "starred",
  "all",
  "anywhere",
] as const;
export type InValue = (typeof IN_VALUES)[number];

export const IS_VALUES = ["unread", "read", "starred", "unstarred", "draft", "settled", "unsettled", "waiting", "snoozed", "pinned"] as const;
export type IsValue = (typeof IS_VALUES)[number];

/** Gmail's inbox categories. Mail from other providers, and Gmail mail not sorted yet, is primary. */
export const CATEGORY_VALUES = ["primary", "promotions", "social", "updates", "forums"] as const;
export type CategoryValue = (typeof CATEGORY_VALUES)[number];

export const FIELD_KEYS = ["from", "to", "cc", "subject", "filename"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export type QueryTerm =
  /** Words or a "quoted phrase", matched against subject, people, body and attachment names. */
  | { kind: "text"; value: string; negated: boolean }
  | { kind: "field"; field: FieldKey; value: string; negated: boolean }
  | { kind: "is"; value: IsValue; negated: boolean }
  | { kind: "has"; value: "attachment" | "summary"; negated: boolean }
  | { kind: "in"; value: InValue; negated: boolean }
  /** Gmail's inbox category of the conversation. */
  | { kind: "category"; value: CategoryValue; negated: boolean }
  /** A label name or id; "none" means conversations without any label. */
  | { kind: "label"; value: string; negated: boolean }
  /** An account email, display name or id. */
  | { kind: "account"; value: string; negated: boolean }
  /** A group name or id; "none" means accounts without a group. */
  | { kind: "group"; value: string; negated: boolean }
  /** Epoch milliseconds. "before" is exclusive, "after" inclusive. */
  | { kind: "date"; op: "before" | "after"; at: number }
  | { kind: "size"; op: "larger" | "smaller"; bytes: number }
  | { kind: "thread"; value: string; negated: boolean }
  /** A server folder by its path ("INBOX", "[Gmail]/Sent Mail", "Rechnungen"); used with account:. */
  | { kind: "mailbox"; value: string; negated: boolean };

export interface ParsedQuery {
  terms: QueryTerm[];
  /** One line per piece that could not be understood; that piece is left out of the search. */
  errors: string[];
}

interface Token {
  negated: boolean;
  key: string | null;
  value: string;
  quoted: boolean;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i++;
    if (i >= n) break;
    if (input[i] === "(" || input[i] === ")") {
      tokens.push({ negated: false, key: null, value: input[i]!, quoted: false });
      i++;
      continue;
    }
    let negated = false;
    if (input[i] === "-" && i + 1 < n && !/\s/.test(input[i + 1]!)) {
      negated = true;
      i++;
    }
    let key: string | null = null;
    // key:value — the key is letters and underscores directly followed by a colon.
    const keyMatch = /^([a-zA-Z_]+):/.exec(input.slice(i));
    if (keyMatch && i + keyMatch[0].length < n && !/\s/.test(input[i + keyMatch[0].length]!)) {
      key = keyMatch[1]!.toLowerCase();
      i += keyMatch[0].length;
    }
    let value = "";
    let quoted = false;
    if (input[i] === '"') {
      quoted = true;
      i++;
      while (i < n && input[i] !== '"') value += input[i++];
      i++; // closing quote (or end of input)
    } else {
      while (i < n && !/\s/.test(input[i]!) && input[i] !== ")") value += input[i++];
    }
    if (value.length > 0 || quoted) tokens.push({ negated, key, value, quoted });
  }
  return tokens;
}

const DAY = 86_400_000;

function parseDate(value: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function parseAge(value: string): number | null {
  const m = /^(\d+)([dwmy])$/i.exec(value);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const days = unit === "d" ? 1 : unit === "w" ? 7 : unit === "m" ? 30 : 365;
  return amount * days * DAY;
}

function parseSize(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(value);
  if (!m) return null;
  const unit = m[2]!.toLowerCase();
  const factor = unit === "k" ? 1024 : unit === "m" ? 1024 ** 2 : unit === "g" ? 1024 ** 3 : 1;
  return Math.round(Number(m[1]) * factor);
}

const PAREN_ERROR = "Parentheses are not supported: all terms must match.";

export function parseQuery(input: string, now: number = Date.now()): ParsedQuery {
  const terms: QueryTerm[] = [];
  const errors: string[] = [];

  for (const token of tokenize(input)) {
    const { negated, key, value } = token;
    const lower = value.toLowerCase();
    if (key === null) {
      if (!token.quoted && (value === "OR" || value === "|" || value === "AND")) {
        errors.push(
          value === "AND"
            ? "AND is not needed: all terms must match already."
            : `"${value}" is not supported: all terms must match. Run one search per alternative instead.`,
        );
        continue;
      }
      if (!token.quoted && /^[()]+$/.test(value)) {
        if (!errors.includes(PAREN_ERROR)) errors.push(PAREN_ERROR);
        continue;
      }
      if (value.trim()) terms.push({ kind: "text", value, negated });
      continue;
    }
    switch (key) {
      case "from":
      case "to":
      case "cc":
      case "subject":
      case "filename":
        terms.push({ kind: "field", field: key, value, negated });
        break;
      case "is":
        if ((IS_VALUES as readonly string[]).includes(lower)) {
          terms.push({ kind: "is", value: lower as IsValue, negated });
        } else if (lower === "important") {
          errors.push(`is:important is not supported. Use one of: ${IS_VALUES.map((v) => `is:${v}`).join(", ")}.`);
        } else {
          errors.push(`Unknown is:${value}. Use one of: ${IS_VALUES.map((v) => `is:${v}`).join(", ")}.`);
        }
        break;
      case "has":
        if (lower === "attachment" || lower === "attachments") {
          terms.push({ kind: "has", value: "attachment", negated });
        } else if (lower === "summary") {
          terms.push({ kind: "has", value: "summary", negated });
        } else {
          errors.push(`Unknown has:${value}. Use has:attachment or has:summary.`);
        }
        break;
      case "in":
        if ((IN_VALUES as readonly string[]).includes(lower)) {
          terms.push({ kind: "in", value: lower as InValue, negated });
        } else {
          errors.push(`Unknown in:${value}. Use one of: ${IN_VALUES.map((v) => `in:${v}`).join(", ")}.`);
        }
        break;
      case "category":
        if ((CATEGORY_VALUES as readonly string[]).includes(lower)) {
          terms.push({ kind: "category", value: lower as CategoryValue, negated });
        } else {
          errors.push(`Unknown category:${value}. Use one of: ${CATEGORY_VALUES.map((v) => `category:${v}`).join(", ")}.`);
        }
        break;
      case "label":
        terms.push({ kind: "label", value, negated });
        break;
      case "account":
        terms.push({ kind: "account", value, negated });
        break;
      case "group":
        terms.push({ kind: "group", value, negated });
        break;
      case "thread":
        terms.push({ kind: "thread", value, negated });
        break;
      case "mailbox":
      case "folder":
        terms.push({ kind: "mailbox", value, negated });
        break;
      case "before":
      case "after": {
        const at = parseDate(value);
        if (at === null) {
          errors.push(`${key}:${value} is not a date. Write it as ${key}:2026-07-31.`);
        } else {
          // before:2026-07-31 means before that day starts; after: includes the day itself.
          terms.push({ kind: "date", op: key, at });
        }
        break;
      }
      case "older_than":
      case "newer_than": {
        const age = parseAge(value);
        if (age === null) {
          errors.push(`${key}:${value} is not an age. Write it as ${key}:30d (d, w, m or y).`);
        } else {
          terms.push({ kind: "date", op: key === "older_than" ? "before" : "after", at: now - age });
        }
        break;
      }
      case "larger":
      case "smaller": {
        const bytes = parseSize(value);
        if (bytes === null) {
          errors.push(`${key}:${value} is not a size. Write it as ${key}:5M (K, M or G).`);
        } else {
          terms.push({ kind: "size", op: key, bytes });
        }
        break;
      }
      default:
        // Not a known key ("re:", "http://..."): search it as text.
        terms.push({ kind: "text", value: `${key}:${value}`, negated });
    }
  }
  return { terms, errors };
}

/** Quote a value for a query when it needs it: label:"Tax 2026". */
export function quoteQueryValue(value: string): string {
  return /[\s"]/.test(value) || value === "" ? `"${value.replace(/"/g, "")}"` : value;
}

/** Whether a query picks its own place (in:...) instead of the default "everywhere but trash and spam". */
export function queryHasLocation(parsed: ParsedQuery): boolean {
  return parsed.terms.some((t) => t.kind === "in" && !t.negated);
}

/** The short reference shown in the search help and given to agents in the MCP tool descriptions. */
export const QUERY_SYNTAX_HELP = [
  "Words and \"quoted phrases\" match subject, people, body and attachment names.",
  "from: to: cc: subject: filename: — match one field (filename:pdf finds PDFs).",
  "is:unread is:read is:starred is:unstarred is:draft · has:attachment · has:summary (an agent wrote one)",
  "is:settled is:waiting is:snoozed is:pinned is:unsettled — where a conversation stands (Fancy Mail's own labels):",
  "  settled: done with · waiting: waiting for an answer · snoozed: later · pinned: kept on top; new mail brings them back",
  "in:inbox in:sent in:drafts in:archive in:starred in:trash in:spam in:anywhere",
  "  (without in:, everything except trash and spam is searched)",
  "label:Invoices label:none · label:Invoices,Receipts (any of them) · account:me@gmail.com · group:Banking group:none",
  "  (several account: and group: terms mean any of them: group:Banking account:me@gmail.com)",
  "category:primary category:promotions category:social category:updates category:forums (Gmail's inbox tabs)",
  "after:2026-07-01 before:2026-10-01 · newer_than:7d older_than:1y (d days, w weeks, m months, y years) · larger:5M smaller:100K",
  "Put - before any term to exclude it: -label:Newsletters -from:noreply",
  "All terms must match; there is no OR — run one search per alternative.",
].join("\n");
