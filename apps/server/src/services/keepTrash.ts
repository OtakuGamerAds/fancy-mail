/**
 * Deleted mail is kept (the Deleted label) instead of sitting in the server's trash, which
 * empties itself (Gmail: after 30 days). Once per account, what is in the trash moves out — on
 * Gmail to All Mail, elsewhere to the Archive folder — with the Deleted label: it still looks
 * deleted (not in the inbox), and nothing is lost. It remembers where it was, so Restore still
 * brings it back.
 */
import { DELETED_LABEL, findDeletedLabel } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import type { Store } from "../store/index.ts";
import type { LabelRecord } from "../store/types.ts";
import type { ServiceEnv } from "./env.ts";
import { invalidate, notifyOutbox, writeActivity } from "./env.ts";
import type { MessageDelta } from "./mutate.ts";
import { planAction } from "./mutate.ts";
import { applyChange } from "./threads.ts";

const BATCH_THREADS = 500;
const BATCH_MESSAGES = 1000;
const doneKey = (accountId: string) => `trash-kept:${accountId}`;
const fixedKey = (accountId: string) => `trash-kept-fixed:${accountId}`;

/** The Deleted label, created when missing. */
export function ensureDeletedLabel(store: Store, now: number): { label: LabelRecord; created: boolean } {
  const existing = findDeletedLabel(store.labels.list());
  if (existing) return { label: existing, created: false };
  const label: LabelRecord = { id: newId("lbl"), name: DELETED_LABEL, color: null, sortOrder: store.labels.nextSortOrder(), createdAt: now };
  store.labels.insert(label);
  return { label, created: true };
}

/**
 * Moves each synced Gmail account's Bin out to Deleted, once. Returns how many conversations
 * moved per account email.
 */
export function keepServerTrash(env: ServiceEnv): Map<string, number> {
  const { store } = env;
  const moved = new Map<string, number>();
  for (const account of store.accounts.list()) {
    if (store.kv.get(doneKey(account.id))) continue;
    // Only once the first sync is done (before, the Bin isn't here yet). Demo mail is all here.
    if (!account.isDemo && (store.accounts.getSyncState(account.id) as { initialDone?: boolean } | null)?.initialDone !== true) continue;
    const trash = store.mailboxes.byRole(account.id, "trash");
    // Gmail: All Mail. Other servers: the Archive folder, when there is one (else the trash stays).
    const keep = store.mailboxes.byRole(account.id, "all") ?? store.mailboxes.byRole(account.id, "archive");
    if (!keep || !trash) {
      store.kv.set(doneKey(account.id), String(env.now()));
      continue;
    }
    const threadIds = env.db
      .all<{ thread_id: string }>(
        `SELECT DISTINCT m.thread_id FROM messages m JOIN message_mailboxes mm ON mm.message_id = m.id
          WHERE mm.mailbox_id = ? AND m.is_draft = 0`,
        trash.id,
      )
      .map((r) => r.thread_id);
    let count = 0;
    if (threadIds.length > 0) {
      const { label } = env.db.tx(() => ensureDeletedLabel(store, env.now()));
      for (let i = 0; i < threadIds.length; i += BATCH_THREADS) {
        const batch = threadIds.slice(i, i + BATCH_THREADS);
        const change = applyChange(
          env,
          [
            {
              action: "keepTrash",
              plan: () => {
                const messages = store.messages.forThreads(batch);
                const inTrash = new Set(
                  store.messages
                    .locations(messages.map((m) => m.id))
                    .filter((l) => l.mailboxId === trash.id)
                    .map((l) => l.messageId),
                );
                const deltas: MessageDelta[] = [];
                for (const m of messages) {
                  if (!inTrash.has(m.id)) continue;
                  // restoreTo stays: where it was before it went to the Bin.
                  deltas.push({ messageId: m.id, addLocations: [keep.id], removeLocations: [trash.id], addLabels: [label.id], removeLabels: [] });
                }
                return deltas;
              },
            },
          ],
          { publish: false },
        );
        count += change.threadIds.length;
      }
    }
    store.kv.set(doneKey(account.id), String(env.now()));
    if (count > 0 && !account.isDemo) {
      moved.set(account.email, count);
      writeActivity(env, {
        actor: { kind: "sync" },
        summary: `Kept ${count.toLocaleString("en-US")} deleted conversation${count === 1 ? "" : "s"} in Deleted (out of the server's trash, which empties itself)`,
        kind: "modify",
        accountIds: [account.id],
      });
    }
  }
  if (moved.size > 0) invalidate(env, ["threads", "accounts", "groups", "mailboxes", "labels", "activity"]);
  return moved;
}

/**
 * The first version moved kept mail from Gmail's Bin "into All Mail", which Gmail ignores: it got
 * the Deleted label but stayed in the Bin (emptied after 30 days). Once per Gmail account, every
 * message with the Deleted label is moved from the Bin into the Deleted folder on the server
 * (wherever it already is, nothing happens). Returns how many messages were sent per account.
 */
export function moveKeptOutOfBin(env: ServiceEnv): Map<string, number> {
  const { store } = env;
  const sent = new Map<string, number>();
  const label = findDeletedLabel(store.labels.list());
  for (const account of store.accounts.list()) {
    if (account.isDemo || store.kv.get(fixedKey(account.id))) continue;
    const trash = store.mailboxes.byRole(account.id, "trash");
    const all = store.mailboxes.byRole(account.id, "all");
    if (!label || !trash || !all) {
      if (!all || !trash) store.kv.set(fixedKey(account.id), String(env.now()));
      continue;
    }
    const messages = env.db.all<{ id: string; remote_id: string | null; message_id_header: string | null; gm_thread_id: string | null }>(
      `SELECT m.id, m.remote_id, m.message_id_header, m.gm_thread_id FROM messages m
         JOIN message_labels ml ON ml.message_id = m.id
        WHERE ml.label_id = ? AND m.account_id = ? AND m.is_draft = 0`,
      label.id,
      account.id,
    );
    env.db.tx(() => {
      for (let i = 0; i < messages.length; i += BATCH_MESSAGES) {
        store.outbox.enqueue(
          account.id,
          {
            kind: "modify",
            action: "keepTrashFix",
            changes: messages.slice(i, i + BATCH_MESSAGES).map((m) => ({
              message: { id: m.id, remoteId: m.remote_id, messageIdHeader: m.message_id_header, gmThreadId: m.gm_thread_id },
              addTo: [],
              removeFrom: [{ id: trash.id, path: trash.path, role: "trash" as const, uid: null }],
              addLabels: [label.name],
              removeLabels: [],
            })),
          },
          env.now(),
        );
      }
      store.kv.set(fixedKey(account.id), String(env.now()));
    });
    if (messages.length > 0) {
      sent.set(account.email, messages.length);
      notifyOutbox(env, [account.id]);
    }
  }
  return sent;
}

/**
 * Deleted mail stays out of the inbox, here and in Gmail: a message that left the Bin gets its
 * old labels back (the inbox among them), and another app may put it back. Quietly archives
 * those (no Activity entry). Returns the conversations it touched.
 */
export function keepDeletedOutOfInbox(env: ServiceEnv): string[] {
  const { store } = env;
  const label = findDeletedLabel(store.labels.list());
  if (!label) return [];
  const threadIds = env.db
    .all<{ thread_id: string }>(
      `SELECT DISTINCT m.thread_id FROM messages m
         JOIN message_labels ml ON ml.message_id = m.id AND ml.label_id = ?
         JOIN message_mailboxes mm ON mm.message_id = m.id
         JOIN mailboxes b ON b.id = mm.mailbox_id AND b.role = 'inbox'`,
      label.id,
    )
    .map((r) => r.thread_id);
  if (threadIds.length === 0) return [];
  const mutateEnv = { store, now: env.now };
  const out: string[] = [];
  for (let i = 0; i < threadIds.length; i += BATCH_THREADS) {
    const batch = threadIds.slice(i, i + BATCH_THREADS);
    const change = applyChange(env, [
      {
        action: "keepDeletedOutOfInbox",
        plan: () => {
          // Only the messages carrying Deleted (the rest of a conversation may be in the inbox on purpose).
          const deleted = new Set(store.messages.labels(store.messages.forThreads(batch).map((m) => m.id)).filter((l) => l.labelId === label.id).map((l) => l.messageId));
          return planAction(mutateEnv, batch, { type: "archive" }).deltas.filter((d) => deleted.has(d.messageId));
        },
      },
    ]);
    out.push(...change.threadIds);
  }
  return out;
}
