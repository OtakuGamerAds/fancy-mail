/**
 * The Settled label, Fancy Mail's own: made the first time something is settled (or found, when
 * Gmail already has a label by that name). It counts as a plain label everywhere else.
 */
import { findSettledLabel, SETTLED_LABEL } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import type { Store } from "../store/index.ts";
import type { LabelRecord } from "../store/types.ts";

/** The Settled label, created when missing. Returns whether it was just created. */
export function ensureSettledLabel(store: Store, now: number): { label: LabelRecord; created: boolean } {
  const existing = findSettledLabel(store.labels.list());
  if (existing) return { label: existing, created: false };
  const label: LabelRecord = { id: newId("lbl"), name: SETTLED_LABEL, color: null, sortOrder: store.labels.nextSortOrder(), createdAt: now };
  store.labels.insert(label);
  return { label, created: true };
}
