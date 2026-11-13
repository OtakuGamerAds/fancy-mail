/**
 * How a local change (an outbox op) becomes IMAP commands. Pure: the worker resolves where each
 * message is on the server right now (`ServerCopy`), these functions say what to do there, and
 * the worker runs the commands (grouped, so archiving 500 conversations is one UID MOVE).
 *
 *   Gmail: read/star are \Seen/\Flagged on the All Mail copy; archive/move to inbox remove/add
 *   the \Inbox label; trash and spam are a MOVE to [Gmail]/Trash or [Gmail]/Spam, and back out
 *   to INBOX (or All Mail when it wasn't in the inbox); labels are X-GM-LABELS by name.
 *   Other IMAP: flags and keywords on every copy; archive/trash/spam/restore are MOVEs between
 *   folders (a COPY first when a message goes back to more than one folder).
 *
 * Nothing here deletes a message: a change that only removes a location is skipped.
 */
import type { MailboxRole } from "@fancy-mail/contracts";

import type { OutboxMessageChange } from "../store/activity.ts";
import { labelToKeyword } from "./keywords.ts";

/** Where a message is on the server, verified (the uid exists in that folder). */
export interface ServerCopy {
  path: string;
  mailboxId: string | null;
  role: MailboxRole | null;
  uid: number;
}

export type ImapCommand =
  | { type: "flags"; path: string; uid: number; messageId: string; add: string[]; remove: string[]; useLabels: boolean }
  | { type: "move" | "copy"; path: string; uid: number; messageId: string; to: string; toMailboxId: string | null };

export interface GmailPaths {
  inbox: string;
  all: string;
  trash: string;
  spam: string;
}

function flagEdits(change: OutboxMessageChange): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  if (change.seen === true) add.push("\\Seen");
  if (change.seen === false) remove.push("\\Seen");
  if (change.flagged === true) add.push("\\Flagged");
  if (change.flagged === false) remove.push("\\Flagged");
  return { add, remove };
}

/** Commands for one change on a Gmail account. `copy` is the message in All Mail, Trash or Spam. */
export function planGmailChange(change: OutboxMessageChange, copy: ServerCopy | null, paths: GmailPaths): ImapCommand[] {
  if (!copy) return [];
  const out: ImapCommand[] = [];
  const messageId = change.message.id;
  const flags = flagEdits(change);
  if (flags.add.length || flags.remove.length) {
    out.push({ type: "flags", path: copy.path, uid: copy.uid, messageId, add: flags.add, remove: flags.remove, useLabels: false });
  }
  if (change.addLabels.length || change.removeLabels.length) {
    out.push({ type: "flags", path: copy.path, uid: copy.uid, messageId, add: change.addLabels, remove: change.removeLabels, useLabels: true });
  }

  const adds = new Set(change.addTo.map((m) => m.role));
  const removes = new Set(change.removeFrom.map((m) => m.role));
  const dead = copy.role === "trash" || copy.role === "spam";
  const target: MailboxRole | null = adds.has("trash") ? "trash" : adds.has("spam") ? "spam" : null;

  if (target) {
    if (copy.role !== target) {
      out.push({ type: "move", path: copy.path, uid: copy.uid, messageId, to: target === "trash" ? paths.trash : paths.spam, toMailboxId: change.addTo.find((m) => m.role === target)?.id ?? null });
    }
  } else if (dead && (removes.has("trash") || removes.has("spam") || adds.has("inbox") || adds.has("all"))) {
    // Out of the Bin or Spam: Gmail ignores a move into All Mail (the message stays where it
    // was), so it moves into a label's folder — the one this change adds (Deleted, for kept
    // deleted mail) — or into the inbox.
    const label = change.addLabels[0];
    const toInbox = adds.has("inbox") || !label;
    out.push({
      type: "move",
      path: copy.path,
      uid: copy.uid,
      messageId,
      to: toInbox ? paths.inbox : label,
      toMailboxId: toInbox ? (change.addTo.find((m) => m.role === "inbox")?.id ?? null) : null,
    });
  } else if (!dead) {
    if (adds.has("inbox")) out.push({ type: "flags", path: copy.path, uid: copy.uid, messageId, add: ["\\Inbox"], remove: [], useLabels: true });
    else if (removes.has("inbox")) out.push({ type: "flags", path: copy.path, uid: copy.uid, messageId, add: [], remove: ["\\Inbox"], useLabels: true });
  }
  return out;
}

/**
 * Commands for one change on a plain IMAP account. `copies` are the message's verified copies on
 * the server before the change.
 */
export function planImapChange(change: OutboxMessageChange, copies: ServerCopy[], options: { keywords: boolean }): ImapCommand[] {
  const out: ImapCommand[] = [];
  const messageId = change.message.id;
  const flags = flagEdits(change);
  if (options.keywords) {
    for (const name of change.addLabels) flags.add.push(labelToKeyword(name));
    for (const name of change.removeLabels) flags.remove.push(labelToKeyword(name));
  }
  if (flags.add.length || flags.remove.length) {
    for (const c of copies) out.push({ type: "flags", path: c.path, uid: c.uid, messageId, add: flags.add, remove: flags.remove, useLabels: false });
  }

  const leaving = change.removeFrom.map((r) => r.path);
  const sources = copies.filter((c) => leaving.includes(c.path));
  const targets = change.addTo.filter((t) => !copies.some((c) => c.path === t.path));
  if (targets.length === 0) return out; // only leaving somewhere: never delete

  if (sources.length === 0) {
    // Going somewhere it isn't, without leaving anything (e.g. back to the inbox from Sent): copy.
    const from = copies[0];
    if (from) for (const t of targets) out.push({ type: "copy", path: from.path, uid: from.uid, messageId, to: t.path, toMailboxId: t.id });
    return out;
  }
  // More targets than sources: copy the extra ones from the first source before it moves.
  const first = sources[0]!;
  for (const t of targets.slice(sources.length)) {
    out.push({ type: "copy", path: first.path, uid: first.uid, messageId, to: t.path, toMailboxId: t.id });
  }
  sources.forEach((s, i) => {
    const t = targets[Math.min(i, targets.length - 1)]!;
    out.push({ type: "move", path: s.path, uid: s.uid, messageId, to: t.path, toMailboxId: t.id });
  });
  return out;
}

/**
 * The most messages one IMAP command acts on. Gmail fails a move of thousands at once (a big
 * cleanup), and smaller steps also mean a retry starts where the last one stopped.
 */
export const MAX_UIDS_PER_COMMAND = 500;

/**
 * Commands that can run as one IMAP command (same kind, folder, target and flags), in steps of
 * at most `maxUids` messages.
 */
export function groupCommands(
  commands: ImapCommand[],
  maxUids = MAX_UIDS_PER_COMMAND,
): { key: string; first: ImapCommand; items: ImapCommand[] }[] {
  return mergeCommands(commands).flatMap((group) => {
    // Commands on the same message stay in the same step.
    const byUid = new Map<number, ImapCommand[]>();
    for (const item of group.items) byUid.set(item.uid, [...(byUid.get(item.uid) ?? []), item]);
    const lists = [...byUid.values()];
    const parts: { key: string; first: ImapCommand; items: ImapCommand[] }[] = [];
    for (let i = 0; i < lists.length; i += maxUids) {
      const items = lists.slice(i, i + maxUids).flat();
      parts.push({ key: group.key, first: items[0]!, items });
    }
    return parts;
  });
}

function mergeCommands(commands: ImapCommand[]): { key: string; first: ImapCommand; items: ImapCommand[] }[] {
  const groups = new Map<string, { key: string; first: ImapCommand; items: ImapCommand[] }>();
  for (const c of commands) {
    const key =
      c.type === "flags"
        ? `flags\u0000${c.path}\u0000${c.useLabels}\u0000${c.add.join("\u0001")}\u0000${c.remove.join("\u0001")}`
        : `${c.type}\u0000${c.path}\u0000${c.to}`;
    const g = groups.get(key);
    if (g) g.items.push(c);
    else groups.set(key, { key, first: c, items: [c] });
  }
  // Keep the order of first appearance, but flags before copies before moves (a move changes the uid).
  const rank = (c: ImapCommand) => (c.type === "flags" ? 0 : c.type === "copy" ? 1 : 2);
  return [...groups.values()].sort((a, b) => rank(a.first) - rank(b.first));
}

/** When a failed op is tried again: 30 s, 1, 2, 5, 10, 20, 40 min. */
export function retryDelayMs(attempts: number): number {
  const steps = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000, 2_400_000];
  return steps[Math.min(Math.max(attempts - 1, 0), steps.length - 1)]!;
}

export const MAX_OP_ATTEMPTS = 8;

/** "2 changes couldn't be saved on the server" (null when none). */
export function failedOpsMessage(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 change couldn't be saved on the server. Sync now to try again."
    : `${count.toLocaleString("en-US")} changes couldn't be saved on the server. Sync now to try again.`;
}

/** Reconnect delays: 5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min. */
export function reconnectDelayMs(failures: number): number {
  const steps = [5_000, 15_000, 30_000, 60_000, 120_000];
  return failures < steps.length ? steps[Math.max(failures, 0)]! : 300_000;
}
