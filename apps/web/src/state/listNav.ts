/**
 * What the visible list holds, for the keyboard (j/k, x, Ctrl+A) and the reader (next
 * conversation after archiving). Kept outside React state: it changes with every page.
 */
import type { ThreadSummary } from "@fancy-mail/contracts";

interface ListNav {
  threads: ThreadSummary[];
  scrollToIndex(index: number): void;
  focusSearch(): void;
}

export const listNav: ListNav = {
  threads: [],
  scrollToIndex: () => {},
  focusSearch: () => {},
};

export function indexOfThread(id: string | null): number {
  if (!id) return -1;
  return listNav.threads.findIndex((t) => t.id === id);
}

/**
 * The conversation to show after `ids` leave the list: the next one below, else above. `skip`
 * passes over rows that aren't a good next stop (settled ones, after settling).
 */
export function neighborAfterRemoving(ids: string[], current: string, skip?: (thread: ThreadSummary) => boolean): string | null {
  const threads = listNav.threads;
  const index = threads.findIndex((t) => t.id === current);
  if (index === -1) return null;
  const gone = new Set(ids);
  const ok = (t: ThreadSummary) => !gone.has(t.id) && !skip?.(t);
  for (let i = index + 1; i < threads.length; i++) if (ok(threads[i]!)) return threads[i]!.id;
  for (let i = index - 1; i >= 0; i--) if (ok(threads[i]!)) return threads[i]!.id;
  return null;
}
