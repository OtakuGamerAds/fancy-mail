/**
 * How a change to conversations becomes changes to messages, and back.
 *
 * A user action (archive, label, …) on some threads is planned into per-message deltas from the
 * current state: locations to add/remove, flags, labels. Applying a delta only does what is
 * still needed and returns what really changed; the inverse of that is the Undo. Undo applies
 * the inverse through the same path, so it is also diffed against the state at that moment
 * (a label added meanwhile by something else is not touched).
 *
 * Location rules per account style:
 *   Gmail-style (the account has an "all" mailbox): archive removes the Inbox location and keeps
 *   All Mail; trash/spam replace every location with Trash/Spam.
 *   IMAP: a message lives in one folder; archive moves INBOX → Archive (a local "Archive" row is
 *   created when the account has none), trash/spam move to Trash/Spam.
 * Restore and not-spam return messages to where they were (remembered on the message), or to
 * the inbox.
 */
import { findSettledLabel } from "@fancy-mail/contracts";
import type { MailboxRole, ModifyAction } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import type { OutboxMessageChange, OutboxPayload } from "../store/activity.ts";
import type { Store } from "../store/index.ts";
import type { MailboxRecord, MessageLocation, MessageRecord } from "../store/types.ts";

export interface MessageDelta {
  messageId: string;
  addLocations: string[];
  removeLocations: string[];
  unread?: boolean;
  starred?: boolean;
  addLabels: string[];
  removeLabels: string[];
  /** Where the message was before it went to the trash or spam (not part of the inverse). */
  restoreTo?: string[] | null;
}

/** What is stored in activity.undo_json for conversation changes. */
export interface ModifyUndo {
  type: "modify";
  deltas: MessageDelta[];
}

export interface ApplyResult {
  /** What really changed (already-true parts left out). */
  applied: MessageDelta[];
  threadIds: string[];
  accountIds: string[];
  /** Mailbox or label counts changed (for the invalidation topics). */
  countsChanged: boolean;
  labelsChanged: boolean;
}

interface MessageState {
  message: MessageRecord;
  locations: MessageLocation[];
  labels: Set<string>;
}

const LOCAL_MAILBOX_PATHS: Partial<Record<MailboxRole, string>> = {
  inbox: "INBOX",
  archive: "Archive",
  trash: "Trash",
  spam: "Junk",
};

export function invertDelta(d: MessageDelta): MessageDelta {
  const out: MessageDelta = {
    messageId: d.messageId,
    addLocations: [...d.removeLocations],
    removeLocations: [...d.addLocations],
    addLabels: [...d.removeLabels],
    removeLabels: [...d.addLabels],
  };
  if (d.unread !== undefined) out.unread = !d.unread;
  if (d.starred !== undefined) out.starred = !d.starred;
  return out;
}

function isEmpty(d: MessageDelta): boolean {
  return (
    d.addLocations.length === 0 &&
    d.removeLocations.length === 0 &&
    d.unread === undefined &&
    d.starred === undefined &&
    d.addLabels.length === 0 &&
    d.removeLabels.length === 0
  );
}

function blank(messageId: string): MessageDelta {
  return { messageId, addLocations: [], removeLocations: [], addLabels: [], removeLabels: [] };
}

export interface MutateEnv {
  store: Store;
  now: () => number;
}

/** Per-account mailbox lookup, creating the local folders an action needs. */
function mailboxResolver(env: MutateEnv) {
  const cache = new Map<string, Map<MailboxRole, MailboxRecord | null>>();
  const created: MailboxRecord[] = [];
  function byRole(accountId: string, role: MailboxRole): MailboxRecord | null {
    let roles = cache.get(accountId);
    if (!roles) cache.set(accountId, (roles = new Map()));
    if (!roles.has(role)) roles.set(role, env.store.mailboxes.byRole(accountId, role));
    return roles.get(role) ?? null;
  }
  function ensure(accountId: string, role: MailboxRole): MailboxRecord {
    const existing = byRole(accountId, role);
    if (existing) return existing;
    const path = LOCAL_MAILBOX_PATHS[role] ?? role[0]!.toUpperCase() + role.slice(1);
    const byPath = env.store.mailboxes.byPath(accountId, path);
    if (byPath) {
      if (!byPath.role) env.store.mailboxes.update(byPath.id, { role });
      const updated = { ...byPath, role };
      cache.get(accountId)!.set(role, updated);
      return updated;
    }
    const mailbox: MailboxRecord = {
      id: newId("mbx"),
      accountId,
      path,
      name: path === "INBOX" ? "Inbox" : path,
      role,
      delimiter: "/",
      specialUse: null,
      uidvalidity: null,
      uidnext: null,
      highestmodseq: null,
      sync: null,
      selectable: true,
      createdLocally: true,
    };
    env.store.mailboxes.insert(mailbox);
    cache.get(accountId)!.set(role, mailbox);
    created.push(mailbox);
    return mailbox;
  }
  return { byRole, ensure, created };
}

function loadStates(store: Store, threadIds: string[]): Map<string, MessageState[]> {
  const messages = store.messages.forThreads(threadIds);
  const ids = messages.map((m) => m.id);
  const locations = new Map<string, MessageLocation[]>();
  for (const loc of store.messages.locations(ids)) {
    const list = locations.get(loc.messageId);
    if (list) list.push(loc);
    else locations.set(loc.messageId, [loc]);
  }
  const labels = new Map<string, Set<string>>();
  for (const row of store.messages.labels(ids)) {
    let set = labels.get(row.messageId);
    if (!set) labels.set(row.messageId, (set = new Set()));
    set.add(row.labelId);
  }
  const out = new Map<string, MessageState[]>();
  for (const id of threadIds) out.set(id, []);
  for (const m of messages) {
    out.get(m.threadId)?.push({ message: m, locations: locations.get(m.id) ?? [], labels: labels.get(m.id) ?? new Set() });
  }
  return out;
}

const hasRole = (s: MessageState, role: MailboxRole) => s.locations.some((l) => l.role === role);
const isDead = (s: MessageState) => hasRole(s, "trash") || hasRole(s, "spam");

/**
 * Plans one action on some threads. May create local mailboxes (e.g. "Archive"); returns them
 * so the caller can tell the sync engine.
 */
export function planAction(
  env: MutateEnv,
  threadIds: string[],
  action: ModifyAction,
): { deltas: MessageDelta[]; createdMailboxes: MailboxRecord[] } {
  const states = loadStates(env.store, threadIds);
  const boxes = mailboxResolver(env);
  const deltas: MessageDelta[] = [];
  const settledLabelId = findSettledLabel(env.store.labels.list())?.id ?? null;
  const gmailCache = new Map<string, boolean>();
  const isGmail = (accountId: string) => {
    if (!gmailCache.has(accountId)) gmailCache.set(accountId, boxes.byRole(accountId, "all") !== null);
    return gmailCache.get(accountId)!;
  };

  for (const threadId of threadIds) {
    const thread = states.get(threadId) ?? [];
    if (thread.length === 0) continue;
    const accountId = thread[0]!.message.accountId;
    const gmail = isGmail(accountId);
    const real = thread.filter((s) => !s.message.isDraft);
    const live = real.filter((s) => !isDead(s));
    const latest = (live.length > 0 ? live : real.length > 0 ? real : thread).at(-1)!;

    /** Where a message goes back to from the trash or spam. */
    const returnTargets = (s: MessageState): string[] => {
      const remembered = (s.message.restoreTo ?? []).filter((id) => {
        const mb = env.store.mailboxes.get(id);
        return mb !== null && mb.role !== "trash" && mb.role !== "spam";
      });
      const targets = remembered.length > 0 ? remembered : [boxes.ensure(accountId, "inbox").id];
      if (gmail) {
        const all = boxes.byRole(accountId, "all");
        if (all && !targets.includes(all.id)) targets.push(all.id);
      }
      return targets;
    };

    switch (action.type) {
      case "markRead":
        for (const s of thread) if (s.message.unread) deltas.push({ ...blank(s.message.id), unread: false });
        break;
      case "markUnread":
        if (!thread.some((s) => s.message.unread)) deltas.push({ ...blank(latest.message.id), unread: true });
        break;
      case "star":
        if (!thread.some((s) => s.message.starred)) deltas.push({ ...blank(latest.message.id), starred: true });
        break;
      case "unstar":
        for (const s of thread) if (s.message.starred) deltas.push({ ...blank(s.message.id), starred: false });
        break;
      case "archive":
        for (const s of thread) {
          const inbox = s.locations.filter((l) => l.role === "inbox");
          if (inbox.length === 0) continue;
          const d = blank(s.message.id);
          d.removeLocations = inbox.map((l) => l.mailboxId);
          if (gmail) {
            const all = boxes.byRole(accountId, "all");
            if (all && !s.locations.some((l) => l.mailboxId === all.id)) d.addLocations.push(all.id);
          } else {
            const archive = boxes.ensure(accountId, "archive");
            if (!s.locations.some((l) => l.mailboxId === archive.id)) d.addLocations.push(archive.id);
          }
          deltas.push(d);
        }
        break;
      case "moveToInbox": {
        let targets = real.filter((s) => !hasRole(s, "inbox") && !hasRole(s, "sent"));
        if (targets.length === 0 && !real.some((s) => hasRole(s, "inbox")) && real.length > 0) targets = [real.at(-1)!];
        const inbox = targets.length > 0 ? boxes.ensure(accountId, "inbox") : null;
        for (const s of targets) {
          const d = blank(s.message.id);
          d.addLocations.push(inbox!.id);
          if (gmail) {
            d.removeLocations = s.locations.filter((l) => l.role === "trash" || l.role === "spam").map((l) => l.mailboxId);
            const all = boxes.byRole(accountId, "all");
            if (all && !s.locations.some((l) => l.mailboxId === all.id)) d.addLocations.push(all.id);
          } else {
            d.removeLocations = s.locations.filter((l) => l.role !== "sent" && l.role !== "drafts").map((l) => l.mailboxId);
          }
          if (isDead(s)) d.restoreTo = null;
          deltas.push(d);
        }
        break;
      }
      case "trash":
      case "markSpam": {
        const role: MailboxRole = action.type === "trash" ? "trash" : "spam";
        for (const s of thread) {
          if (hasRole(s, role)) continue;
          if (role === "spam" && s.message.isDraft) continue;
          const target = boxes.ensure(accountId, role);
          const d = blank(s.message.id);
          d.removeLocations = s.locations.map((l) => l.mailboxId);
          d.addLocations = [target.id];
          d.restoreTo = s.locations.filter((l) => l.role !== "trash" && l.role !== "spam").map((l) => l.mailboxId);
          deltas.push(d);
        }
        break;
      }
      case "restore":
      case "notSpam": {
        const role: MailboxRole = action.type === "restore" ? "trash" : "spam";
        for (const s of thread) {
          const from = s.locations.filter((l) => l.role === role);
          if (from.length === 0) continue;
          const d = blank(s.message.id);
          d.removeLocations = from.map((l) => l.mailboxId);
          d.addLocations = returnTargets(s).filter((id) => !s.locations.some((l) => l.mailboxId === id));
          d.restoreTo = null;
          deltas.push(d);
        }
        break;
      }
      case "settle":
        // Every message carries the label (so it shows in Gmail on any of them) and is read.
        if (!settledLabelId) break;
        for (const s of thread) {
          const d = blank(s.message.id);
          if (!s.labels.has(settledLabelId)) d.addLabels.push(settledLabelId);
          if (s.message.unread) d.unread = false;
          if (!isEmpty(d)) deltas.push(d);
        }
        break;
      case "unsettle":
        if (!settledLabelId) break;
        for (const s of thread) if (s.labels.has(settledLabelId)) deltas.push({ ...blank(s.message.id), removeLabels: [settledLabelId] });
        break;
      case "addLabels":
      case "removeLabels": {
        const adding = action.type === "addLabels";
        for (const s of thread) {
          const d = blank(s.message.id);
          for (const labelId of action.labelIds) {
            const has = s.labels.has(labelId);
            if (adding && !has) d.addLabels.push(labelId);
            if (!adding && has) d.removeLabels.push(labelId);
          }
          if (!isEmpty(d)) deltas.push(d);
        }
        break;
      }
    }
  }
  return { deltas, createdMailboxes: boxes.created };
}

/**
 * Applies deltas to the database (inside the caller's transaction), only where still needed.
 * Returns what changed. Does not refresh threads or publish anything.
 */
export function applyDeltas(env: MutateEnv, deltas: MessageDelta[]): ApplyResult {
  const { store } = env;
  const ids = [...new Set(deltas.map((d) => d.messageId))];
  const messages = new Map(store.messages.byIds(ids).map((m) => [m.id, m]));
  const locations = new Map<string, Map<string, MessageLocation>>();
  for (const loc of store.messages.locations(ids)) {
    let map = locations.get(loc.messageId);
    if (!map) locations.set(loc.messageId, (map = new Map()));
    map.set(loc.mailboxId, loc);
  }
  const labels = new Map<string, Set<string>>();
  for (const row of store.messages.labels(ids)) {
    let set = labels.get(row.messageId);
    if (!set) labels.set(row.messageId, (set = new Set()));
    set.add(row.labelId);
  }
  const mailboxExists = new Map<string, boolean>();
  const mailboxOk = (id: string, accountId: string) => {
    if (!mailboxExists.has(id)) {
      const mb = store.mailboxes.get(id);
      mailboxExists.set(id, mb !== null && mb.accountId === accountId);
    }
    return mailboxExists.get(id)!;
  };
  const labelExists = new Map<string, boolean>();
  const labelOk = (id: string) => {
    if (!labelExists.has(id)) labelExists.set(id, store.labels.get(id) !== null);
    return labelExists.get(id)!;
  };

  const applied: MessageDelta[] = [];
  const threadIds = new Set<string>();
  const accountIds = new Set<string>();
  let countsChanged = false;
  let labelsChanged = false;

  for (const delta of deltas) {
    const message = messages.get(delta.messageId);
    if (!message) continue; // deleted meanwhile
    const locs = locations.get(message.id) ?? new Map<string, MessageLocation>();
    locations.set(message.id, locs);
    const own = labels.get(message.id) ?? new Set<string>();
    labels.set(message.id, own);
    const done = blank(message.id);

    for (const mailboxId of delta.removeLocations) {
      if (!locs.has(mailboxId)) continue;
      store.messages.removeLocation(message.id, mailboxId);
      locs.delete(mailboxId);
      done.removeLocations.push(mailboxId);
    }
    for (const mailboxId of delta.addLocations) {
      if (locs.has(mailboxId) || !mailboxOk(mailboxId, message.accountId)) continue;
      store.messages.addLocation(message.id, mailboxId, null);
      locs.set(mailboxId, { messageId: message.id, mailboxId, uid: null, role: null, path: "" });
      done.addLocations.push(mailboxId);
    }
    if (delta.unread !== undefined && message.unread !== delta.unread) {
      store.messages.setFlags([message.id], { unread: delta.unread });
      message.unread = delta.unread;
      done.unread = delta.unread;
    }
    if (delta.starred !== undefined && message.starred !== delta.starred) {
      store.messages.setFlags([message.id], { starred: delta.starred });
      message.starred = delta.starred;
      done.starred = delta.starred;
    }
    for (const labelId of delta.removeLabels) {
      if (!own.has(labelId)) continue;
      store.messages.removeLabel(message.id, labelId);
      own.delete(labelId);
      done.removeLabels.push(labelId);
    }
    for (const labelId of delta.addLabels) {
      if (own.has(labelId) || !labelOk(labelId)) continue;
      store.messages.addLabel(message.id, labelId);
      own.add(labelId);
      done.addLabels.push(labelId);
    }
    if (delta.restoreTo !== undefined) store.messages.update(message.id, { restoreTo: delta.restoreTo });

    if (isEmpty(done)) continue;
    applied.push(done);
    threadIds.add(message.threadId);
    accountIds.add(message.accountId);
    if (done.addLocations.length || done.removeLocations.length || done.unread !== undefined) countsChanged = true;
    if (done.addLabels.length || done.removeLabels.length || done.unread !== undefined) labelsChanged = true;
  }
  return { applied, threadIds: [...threadIds], accountIds: [...accountIds], countsChanged, labelsChanged };
}

/**
 * The outbox ops for applied deltas: one per account, with message references, mailbox paths
 * and the uids the messages had where they left, plus label names. Demo accounts get none.
 */
export function outboxOpsFor(
  store: Store,
  applied: MessageDelta[],
  action: string,
  locationsBefore: Map<string, MessageLocation[]>,
): { accountId: string; payload: OutboxPayload }[] {
  if (applied.length === 0) return [];
  const messages = new Map(store.messages.byIds(applied.map((d) => d.messageId)).map((m) => [m.id, m]));
  const mailboxCache = new Map<string, MailboxRecord | null>();
  const mailbox = (id: string) => {
    if (!mailboxCache.has(id)) mailboxCache.set(id, store.mailboxes.get(id));
    return mailboxCache.get(id) ?? null;
  };
  const labelNames = new Map(store.labels.list().map((l) => [l.id, l.name]));
  const byAccount = new Map<string, OutboxMessageChange[]>();
  const demo = new Map<string, boolean>();

  for (const d of applied) {
    const m = messages.get(d.messageId);
    if (!m) continue;
    if (!demo.has(m.accountId)) demo.set(m.accountId, store.accounts.isDemo(m.accountId));
    if (demo.get(m.accountId)) continue;
    const before = locationsBefore.get(m.id) ?? [];
    const change: OutboxMessageChange = {
      message: { id: m.id, remoteId: m.remoteId, messageIdHeader: m.messageIdHeader, gmThreadId: m.gmThreadId },
      addTo: d.addLocations.flatMap((id) => {
        const mb = mailbox(id);
        return mb ? [{ id: mb.id, path: mb.path, role: mb.role }] : [];
      }),
      removeFrom: d.removeLocations.flatMap((id) => {
        const mb = mailbox(id);
        const uid = before.find((l) => l.mailboxId === id)?.uid ?? null;
        return mb ? [{ id: mb.id, path: mb.path, role: mb.role, uid }] : [];
      }),
      addLabels: d.addLabels.flatMap((id) => (labelNames.has(id) ? [labelNames.get(id)!] : [])),
      removeLabels: d.removeLabels.flatMap((id) => (labelNames.has(id) ? [labelNames.get(id)!] : [])),
    };
    if (d.unread !== undefined) change.seen = !d.unread;
    if (d.starred !== undefined) change.flagged = d.starred;
    const list = byAccount.get(m.accountId);
    if (list) list.push(change);
    else byAccount.set(m.accountId, [change]);
  }
  return [...byAccount].map(([accountId, changes]) => ({ accountId, payload: { kind: "modify", action, changes } }));
}

/** Current locations of the messages a set of deltas touches (for uids in outbox ops). */
export function locationsOf(store: Store, deltas: MessageDelta[]): Map<string, MessageLocation[]> {
  const out = new Map<string, MessageLocation[]>();
  for (const loc of store.messages.locations([...new Set(deltas.map((d) => d.messageId))])) {
    const list = out.get(loc.messageId);
    if (list) list.push(loc);
    else out.set(loc.messageId, [loc]);
  }
  return out;
}

// ── Summaries ───────────────────────────────────────────────────────────────────────────────

function conversations(n: number): string {
  return n === 1 ? "1 conversation" : `${n.toLocaleString("en-US")} conversations`;
}

function quoteList(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Archived 3 conversations", "Labeled 12 conversations Invoices", "Marked 2 as read". */
export function summarize(actions: ModifyAction[], count: number, labelName: (id: string) => string): string {
  const phrase = (a: ModifyAction, n: string): string => {
    switch (a.type) {
      case "markRead":
        return `Marked ${n} as read`;
      case "markUnread":
        return `Marked ${n} as unread`;
      case "star":
        return `Starred ${n}`;
      case "unstar":
        return `Unstarred ${n}`;
      case "archive":
        return `Archived ${n}`;
      case "moveToInbox":
        return `Moved ${n} to the inbox`;
      case "trash":
        return `Moved ${n} to the trash`;
      case "restore":
        return `Restored ${n} from the trash`;
      case "markSpam":
        return `Reported ${n} as spam`;
      case "notSpam":
        return `Marked ${n} as not spam`;
      case "settle":
        return `Settled ${n}`;
      case "unsettle":
        return `Un-settled ${n}`;
      case "addLabels":
        return `Labeled ${n} ${quoteList(a.labelIds.map(labelName))}`;
      case "removeLabels":
        return `Removed ${quoteList(a.labelIds.map(labelName))} from ${n}`;
    }
  };
  const n = conversations(count);
  if (actions.length === 1) {
    const only = actions[0]!;
    // "Marked 2 as read" reads better without "conversations" for read state.
    if (only.type === "markRead" || only.type === "markUnread") return phrase(only, String(count));
    return phrase(only, n);
  }
  const [first, ...rest] = actions;
  const tail = rest.map((a) => {
    const p = phrase(a, "them");
    return p[0]!.toLowerCase() + p.slice(1);
  });
  return `${phrase(first!, n)}, ${quoteList(tail)}`;
}
