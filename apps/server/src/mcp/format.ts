/**
 * How mail looks to an agent. Compact, high-signal text: names and addresses instead of bare
 * ids, ids where the next call needs them, dates an agent can compare, and truncation notes
 * that say exactly how to get more. Email content is wrapped as untrusted.
 */
import type {
  Account,
  Activity,
  Address,
  AttachmentMeta,
  Draft,
  Label,
  Message,
  ThreadSummary,
} from "@fancy-mail/contracts";

export function formatAddress(a: Address | null | undefined): string {
  if (!a) return "(unknown)";
  return a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address;
}

export function formatAddresses(list: Address[], max = 6): string {
  if (list.length === 0) return "";
  const shown = list.slice(0, max).map((a) => formatAddress(a));
  return list.length > max ? `${shown.join(", ")} +${list.length - max} more` : shown.join(", ");
}

/** 2026-11-03 14:05 (local time), sortable and unambiguous. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface Lookups {
  accounts: Map<string, Account>;
  labels: Map<string, Label>;
}

function labelNames(ids: string[], lookups: Lookups): string[] {
  return ids.map((id) => lookups.labels.get(id)?.name).filter((n): n is string => Boolean(n));
}

function threadFlags(t: ThreadSummary): string {
  const flags: string[] = [];
  if (t.unreadCount > 0) flags.push("unread");
  if (t.starred) flags.push("★");
  if (t.hasAttachments) flags.push("📎");
  if (t.draftCount > 0) flags.push("draft");
  if (t.inTrash) flags.push("trash");
  else if (t.inSpam) flags.push("spam");
  else if (!t.inInbox) flags.push("archived");
  return flags.join(",");
}

/** The sender line of a conversation: its first participant, plus "+N" when more wrote. */
function threadFrom(t: ThreadSummary): string {
  const first = t.participants[0];
  const more = t.participants.length > 1 ? ` +${t.participants.length - 1}` : "";
  return `${formatAddress(first)}${more}`;
}

export function formatThreadConcise(t: ThreadSummary, lookups: Lookups): string {
  const account = lookups.accounts.get(t.accountId)?.email ?? t.accountId;
  const labels = labelNames(t.labelIds, lookups);
  const parts = [
    t.id,
    formatDate(t.lastMessageAt),
    account,
    threadFrom(t),
    oneLine(t.subject || "(no subject)", 120),
  ];
  const flags = threadFlags(t);
  if (flags) parts.push(flags);
  if (labels.length) parts.push(`labels: ${labels.join(", ")}`);
  if (t.snippet) parts.push(oneLine(t.snippet, 100));
  return parts.join(" | ");
}

export function formatThreadDetailed(t: ThreadSummary, lookups: Lookups): string {
  const account = lookups.accounts.get(t.accountId);
  const labels = labelNames(t.labelIds, lookups);
  return [
    `${t.id} — ${t.subject || "(no subject)"}`,
    `  account: ${account ? `${account.email} (${account.displayName})` : t.accountId}`,
    `  people: ${formatAddresses(t.participants, 10)}`,
    `  last message: ${formatDate(t.lastMessageAt)} · ${t.messageCount} message${t.messageCount === 1 ? "" : "s"} · ${t.unreadCount} unread`,
    `  where: ${threadFlags(t) || "inbox"}${t.inInbox ? " (inbox)" : ""}`,
    `  labels: ${labels.length ? labels.join(", ") : "none"}`,
    t.snippet ? `  snippet: ${oneLine(t.snippet, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Message bodies ──────────────────────────────────────────────────────────────────────────

/**
 * Drops quoted replies: lines starting with ">" and everything from an attribution line
 * ("On Tue, … wrote:", "Am … schrieb …:", "-----Original Message-----") onward.
 */
export function stripQuoted(text: string): { text: string; stripped: boolean } {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let stripped = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      /^(On .+wrote:|Am .+schrieb .+:|Le .+a écrit\s?:|-{2,}\s*(Original Message|Ursprüngliche Nachricht)\s*-{2,})$/i.test(
        trimmed,
      ) ||
      /^From: .+$/.test(trimmed) && out.length > 0 && out[out.length - 1]!.trim() === ""
    ) {
      stripped = true;
      break;
    }
    if (trimmed.startsWith(">")) {
      stripped = true;
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), stripped };
}

export function truncateBody(text: string, maxChars: number): { text: string; note: string | null } {
  if (text.length <= maxChars) return { text, note: null };
  const remaining = text.length - maxChars;
  const suggestion = Math.min(30_000, Math.max(maxChars * 2, text.length));
  return {
    text: text.slice(0, maxChars),
    note: `[… ${remaining.toLocaleString("en-US")} more characters — call again with max_chars_per_message: ${suggestion}]`,
  };
}

export function untrusted(content: string): string {
  return `<email_body untrusted="true">\n${content}\n</email_body>`;
}

export function formatAttachment(a: AttachmentMeta): string {
  return `${a.id} · ${a.filename} · ${a.mimeType} · ${formatSize(a.size)}`;
}

export function formatMessageHeader(m: Message): string {
  const lines = [`── ${m.id} · ${formatDate(m.date)}${m.unread ? " · unread" : ""}${m.isDraft ? " · draft" : ""}`];
  lines.push(`From: ${formatAddress(m.from)}`);
  if (m.to.length) lines.push(`To: ${formatAddresses(m.to)}`);
  if (m.cc.length) lines.push(`Cc: ${formatAddresses(m.cc)}`);
  if (m.replyTo.length && m.replyTo[0]?.address !== m.from?.address) {
    lines.push(`Reply-To: ${formatAddresses(m.replyTo)}`);
  }
  return lines.join("\n");
}

export function actorName(actor: Activity["actor"] | Draft["createdBy"]): string {
  switch (actor.kind) {
    case "user":
      return "the user";
    case "sync":
      return "sync";
    case "agent":
      return actor.name;
  }
}

export function formatActivity(a: Activity): string {
  const state = a.undoneAt ? " · undone" : a.undoable ? " · undoable" : "";
  return `${a.id} · ${formatDate(a.at)} · ${actorName(a.actor)} · ${a.summary}${state}`;
}

export function formatDraft(d: Draft, lookups: Lookups): string {
  const account = lookups.accounts.get(d.accountId)?.email ?? d.accountId;
  const to = formatAddresses(d.to) || "(no recipients)";
  return `${d.id} · ${account} → ${to} · ${oneLine(d.subject || "(no subject)", 80)} · by ${actorName(d.createdBy)} · ${d.sendState}${d.sendError ? ` (${d.sendError})` : ""}`;
}

/** "Name <a@b>", "a@b" or "Name a@b" → Address; null when there is no address in it. */
export function parseAddress(input: string): Address | null {
  const trimmed = input.trim();
  const angle = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"|"$/g, "");
    return { name: name || null, address: angle[2]!.trim() };
  }
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(trimmed);
  if (!bare) return null;
  const name = trimmed.replace(bare[1]!, "").trim().replace(/^"|"$/g, "");
  return { name: name || null, address: bare[1]! };
}
