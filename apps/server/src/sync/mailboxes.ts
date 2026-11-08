/**
 * Which server folders become mailbox rows, which role each gets, and which ones are synced.
 *
 * Gmail (X-GM-EXT-1): messages are fetched from All Mail, Trash and Spam only. Inbox, Sent,
 * Drafts, Starred and Important are rows too, but membership in them comes from a message's
 * X-GM-LABELS (locations with uid NULL). User labels are not mailboxes here: they become the
 * app's global labels.
 *
 * Other IMAP: every selectable folder is synced, except virtual ones (\All, \Flagged), which
 * would show every message twice.
 */
import type { MailboxRole } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import type { Store } from "../store/index.ts";
import type { MailboxRecord } from "../store/types.ts";

const SPECIAL_USE: Record<string, MailboxRole> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "spam",
  "\\archive": "archive",
  "\\all": "all",
  "\\flagged": "starred",
  "\\important": "important",
};

/** The role of a special-use flag. Off Gmail, \All, \Flagged and \Important are virtual: no role. */
export function specialUseRole(specialUse: string | null | undefined, gmail: boolean): MailboxRole | null {
  if (!specialUse) return null;
  const role = SPECIAL_USE[specialUse.toLowerCase()] ?? null;
  if (!gmail && (role === "all" || role === "starred" || role === "important")) return null;
  return role;
}

/** Gmail's system labels as X-GM-LABELS spells them. */
export const GMAIL_SYSTEM_LABELS: Readonly<Record<string, MailboxRole>> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\draft": "drafts",
  "\\drafts": "drafts",
  "\\starred": "starred",
  "\\important": "important",
  "\\trash": "trash",
  "\\spam": "spam",
};

const ROLE_TO_GMAIL_LABEL: Partial<Record<MailboxRole, string>> = {
  inbox: "\\Inbox",
  sent: "\\Sent",
  drafts: "\\Draft",
  starred: "\\Starred",
  important: "\\Important",
};

export function gmailLabelForRole(role: MailboxRole): string | null {
  return ROLE_TO_GMAIL_LABEL[role] ?? null;
}

/** Splits X-GM-LABELS into system roles and user label names. */
export function splitGmailLabels(labels: Iterable<string>): { roles: Set<MailboxRole>; names: string[] } {
  const roles = new Set<MailboxRole>();
  const names: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    if (!label) continue;
    const role = GMAIL_SYSTEM_LABELS[label.toLowerCase()];
    if (role) roles.add(role);
    else if (label.startsWith("\\")) continue; // other system labels (\Muted, …)
    else if (label.toLowerCase() === "inbox") roles.add("inbox");
    else names.push(label);
  }
  return { roles, names };
}

/** The roles a Gmail message gets from its labels while it lives in All Mail (virtual locations). */
export const GMAIL_VIRTUAL_ROLES: readonly MailboxRole[] = ["inbox", "sent", "drafts", "starred", "important"];

export interface ServerMailbox {
  path: string;
  name: string;
  delimiter: string | null;
  specialUse: string | null;
  /** How imapflow found the special use: from the server ("user"/"extension") or guessed by name. */
  specialUseSource: string | null;
  flags: string[];
}

export interface PlannedMailbox {
  path: string;
  name: string;
  role: MailboxRole | null;
  delimiter: string | null;
  specialUse: string | null;
  selectable: boolean;
  /** Messages are fetched from it. */
  synced: boolean;
}

function lower(flags: string[]): Set<string> {
  return new Set(flags.map((f) => f.toLowerCase()));
}

const SYNC_ORDER: Record<string, number> = { inbox: 0, all: 0, sent: 1, archive: 2, drafts: 3, other: 4, spam: 5, trash: 6 };

/** Inbox first (it is what the person looks at), trash and spam last. */
export function syncOrder(role: MailboxRole | null): number {
  return SYNC_ORDER[role ?? "other"] ?? 4;
}

function displayName(path: string, name: string, role: MailboxRole | null): string {
  if (path.toUpperCase() === "INBOX" || role === "inbox") return "Inbox";
  return name || path;
}

/** Decides rows and roles from a LIST response. */
export function planMailboxes(server: ServerMailbox[], gmail: boolean): PlannedMailbox[] {
  const candidates: (PlannedMailbox & { priority: number })[] = [];
  for (const mb of server) {
    const flags = lower(mb.flags);
    const selectable = !flags.has("\\noselect") && !flags.has("\\nonexistent");
    if (!selectable) continue;
    const isInbox = mb.path.toUpperCase() === "INBOX";
    let role = isInbox ? "inbox" : specialUseRole(mb.specialUse, gmail);
    if (!gmail && mb.specialUse && ["\\all", "\\flagged", "\\important"].includes(mb.specialUse.toLowerCase())) continue; // virtual
    if (gmail && !role) continue; // a user label: handled as a label, not a folder
    if (role === "inbox" && !isInbox) role = null;
    const priority = isInbox ? 0 : mb.specialUseSource === "name" ? 2 : 1;
    candidates.push({
      path: isInbox ? "INBOX" : mb.path,
      name: displayName(mb.path, mb.name, role),
      role,
      delimiter: mb.delimiter,
      specialUse: mb.specialUse,
      selectable,
      synced: gmail ? role === "all" || role === "trash" || role === "spam" : true,
      priority,
    });
  }
  // One mailbox per role: the server's own flag beats a guess from the name.
  const taken = new Map<MailboxRole, PlannedMailbox & { priority: number }>();
  for (const c of [...candidates].sort((a, b) => a.priority - b.priority || a.path.length - b.path.length)) {
    if (!c.role) continue;
    if (taken.has(c.role)) c.role = null;
    else taken.set(c.role, c);
  }
  const out = candidates.filter((c) => gmail ? c.role !== null : true).map(({ priority: _p, ...rest }) => rest);
  return out.sort((a, b) => syncOrder(a.role) - syncOrder(b.role) || a.path.localeCompare(b.path));
}

export interface ReconcileResult {
  /** Rows by path, after the change. */
  byPath: Map<string, MailboxRecord>;
  /** Rows removed because the folder is gone on the server (their locations went with them). */
  removed: string[];
  changed: boolean;
}

/**
 * Brings the mailbox rows in line with the server: new folders are added, renamed ones keep
 * their id (matched by role), vanished ones are removed. Rows the app created locally and has not
 * created on the server yet are kept.
 */
export function reconcileMailboxes(store: Store, accountId: string, planned: PlannedMailbox[]): ReconcileResult {
  const existing = store.mailboxes.list(accountId);
  const byPath = new Map(existing.map((m) => [m.path, m]));
  const seen = new Set<string>();
  const removed: string[] = [];
  let changed = false;

  store.db.tx(() => {
    for (const p of planned) {
      let row = byPath.get(p.path) ?? null;
      if (!row && p.role) {
        // Renamed on the server: same role, old path gone.
        const plannedPaths = new Set(planned.map((x) => x.path));
        const old = existing.find((m) => m.role === p.role && !plannedPaths.has(m.path) && !seen.has(m.path));
        if (old) {
          store.mailboxes.update(old.id, { path: p.path, name: p.name });
          byPath.delete(old.path);
          row = { ...old, path: p.path, name: p.name };
          byPath.set(p.path, row);
          changed = true;
        }
      }
      if (!row) {
        // A row the app made (role taken locally) that now exists for real, under another path.
        const local = p.role ? existing.find((m) => m.createdLocally && m.role === p.role && !seen.has(m.path)) : undefined;
        if (local && local.path !== p.path) {
          store.mailboxes.update(local.id, { path: p.path, name: p.name, createdLocally: false, specialUse: p.specialUse, delimiter: p.delimiter });
          byPath.delete(local.path);
          row = { ...local, path: p.path, name: p.name, createdLocally: false };
          byPath.set(p.path, row);
          changed = true;
        }
      }
      if (!row) {
        const record: MailboxRecord = {
          id: newId("mbx"),
          accountId,
          path: p.path,
          name: p.name,
          role: p.role,
          delimiter: p.delimiter,
          specialUse: p.specialUse,
          uidvalidity: null,
          uidnext: null,
          highestmodseq: null,
          sync: null,
          selectable: p.selectable,
          createdLocally: false,
        };
        // A role can only be held once: a row with this role and another path loses it.
        if (p.role) {
          for (const m of existing) {
            if (m.role === p.role && m.path !== p.path && !m.createdLocally) {
              store.mailboxes.update(m.id, { role: null });
              m.role = null;
            }
          }
        }
        store.mailboxes.insert(record);
        byPath.set(p.path, record);
        row = record;
        changed = true;
      } else {
        const patch: Partial<MailboxRecord> = {};
        if (row.name !== p.name) patch.name = p.name;
        if (row.createdLocally) patch.createdLocally = false;
        if ((row.specialUse ?? null) !== (p.specialUse ?? null)) patch.specialUse = p.specialUse;
        if (p.role && row.role !== p.role) patch.role = p.role;
        // Keep a role the app assigned (e.g. our "Archive") when the server has no flag for it.
        if (Object.keys(patch).length > 0) {
          store.mailboxes.update(row.id, patch);
          Object.assign(row, patch);
          changed = true;
        }
      }
      seen.add(p.path);
    }

    for (const m of store.mailboxes.list(accountId)) {
      if (seen.has(m.path) || m.createdLocally) continue;
      store.mailboxes.delete(m.id);
      byPath.delete(m.path);
      removed.push(m.id);
      changed = true;
    }
  });
  return { byPath, removed, changed };
}
