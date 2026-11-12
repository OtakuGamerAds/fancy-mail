/**
 * When waiting and snoozed conversations come back (thread_timers), and why some came back
 * (thread_marks, shown on the row until it's opened). The states themselves are labels.
 */
import type { ThreadMark, ThreadTimer } from "@fancy-mail/contracts";

import type { Db } from "../db/sqlite.ts";

interface TimerRow {
  thread_id: string;
  kind: ThreadTimer["kind"];
  until: number;
  set_at: number;
}

interface MarkRow {
  thread_id: string;
  kind: ThreadMark["kind"];
  at: number;
}

const toTimer = (r: TimerRow): ThreadTimer => ({ threadId: r.thread_id, kind: r.kind, until: r.until, setAt: r.set_at });
const toMark = (r: MarkRow): ThreadMark => ({ threadId: r.thread_id, kind: r.kind, at: r.at });

export function createThreadStatesStore(db: Db) {
  return {
    timers(): ThreadTimer[] {
      return db.all<TimerRow>("SELECT * FROM thread_timers ORDER BY until").map(toTimer);
    },
    timersFor(threadIds: string[]): ThreadTimer[] {
      if (threadIds.length === 0) return [];
      return db
        .all<TimerRow>(`SELECT * FROM thread_timers WHERE thread_id IN (${threadIds.map(() => "?").join(", ")})`, ...threadIds)
        .map(toTimer);
    },
    due(now: number): ThreadTimer[] {
      return db.all<TimerRow>("SELECT * FROM thread_timers WHERE until <= ? ORDER BY until", now).map(toTimer);
    },
    /** The next time something comes back (null: nothing waits). */
    nextDue(): number | null {
      return db.value<number>("SELECT MIN(until) FROM thread_timers") ?? null;
    },
    setTimer(timer: ThreadTimer): void {
      db.run(
        `INSERT INTO thread_timers (thread_id, kind, until, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET kind = excluded.kind, until = excluded.until, set_at = excluded.set_at`,
        timer.threadId,
        timer.kind,
        timer.until,
        timer.setAt,
      );
    },
    clearTimers(threadIds: string[]): void {
      for (const id of threadIds) db.run("DELETE FROM thread_timers WHERE thread_id = ?", id);
    },
    marks(): ThreadMark[] {
      return db.all<MarkRow>("SELECT * FROM thread_marks").map(toMark);
    },
    setMark(mark: ThreadMark): void {
      db.run(
        `INSERT INTO thread_marks (thread_id, kind, at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET kind = excluded.kind, at = excluded.at`,
        mark.threadId,
        mark.kind,
        mark.at,
      );
    },
    /** Returns whether there was one. */
    clearMark(threadId: string): boolean {
      return db.run("DELETE FROM thread_marks WHERE thread_id = ?", threadId).changes > 0;
    },
    clearMarks(threadIds: string[]): void {
      for (const id of threadIds) db.run("DELETE FROM thread_marks WHERE thread_id = ?", id);
    },
  };
}

export type ThreadStatesStore = ReturnType<typeof createThreadStatesStore>;
