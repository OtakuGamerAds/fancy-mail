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
import { invalidate, writeActivity } from "./env.ts";
import type { MessageDelta } from "./mutate.ts";
import { applyChange } from "./threads.ts";

const BATCH_THREADS = 500;
const doneKey = (accountId: string) => `trash-kept:${accountId}`;

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
