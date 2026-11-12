/**
 * Fancy Mail's own labels for where a conversation stands (Settled, Waiting, Snoozed, Pinned):
 * made the first time they're used (or found, when Gmail already has a label by that name). They
 * count as plain labels everywhere else.
 */
import { findStateLabel, STATE_LABELS, type StateLabelKey } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import type { Store } from "../store/index.ts";
import type { LabelRecord } from "../store/types.ts";

/** The label for this state, created when missing. Returns whether it was just created. */
export function ensureStateLabel(store: Store, key: StateLabelKey, now: number): { label: LabelRecord; created: boolean } {
  const existing = findStateLabel(store.labels.list(), key);
  if (existing) return { label: existing, created: false };
  const label: LabelRecord = { id: newId("lbl"), name: STATE_LABELS[key], color: null, sortOrder: store.labels.nextSortOrder(), createdAt: now };
  store.labels.insert(label);
  return { label, created: true };
}

export function ensureSettledLabel(store: Store, now: number): { label: LabelRecord; created: boolean } {
  return ensureStateLabel(store, "settled", now);
}

/** The ids of the state labels that exist (missing ones are left out). */
export function stateLabelIds(store: Store): Partial<Record<StateLabelKey, string>> {
  const labels = store.labels.list();
  const out: Partial<Record<StateLabelKey, string>> = {};
  for (const key of Object.keys(STATE_LABELS) as StateLabelKey[]) {
    const label = findStateLabel(labels, key);
    if (label) out[key] = label.id;
  }
  return out;
}

/** The label a state action adds (settle → settled…), if any. */
export const ACTION_STATE: Partial<Record<string, StateLabelKey>> = {
  settle: "settled",
  wait: "waiting",
  snooze: "snoozed",
  pin: "pinned",
};
