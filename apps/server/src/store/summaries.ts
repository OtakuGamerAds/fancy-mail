/** What agents wrote about conversations (thread_summaries): one per conversation. */
import type { Actor, AiSummary } from "@fancy-mail/contracts";

import type { Db } from "../db/sqlite.ts";

interface SummaryRow {
  thread_id: string;
  text: string;
  by_json: string;
  at: number;
}

const toSummary = (r: SummaryRow): AiSummary => ({ text: r.text, by: JSON.parse(r.by_json) as Actor, at: r.at });

export function createSummariesStore(db: Db) {
  return {
    get(threadId: string): AiSummary | null {
      const row = db.get<SummaryRow>("SELECT * FROM thread_summaries WHERE thread_id = ?", threadId);
      return row ? toSummary(row) : null;
    },
    set(threadId: string, summary: AiSummary): void {
      db.run(
        `INSERT INTO thread_summaries (thread_id, text, by_json, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, by_json = excluded.by_json, at = excluded.at`,
        threadId,
        summary.text,
        JSON.stringify(summary.by),
        summary.at,
      );
    },
    /** Returns whether there was one. */
    remove(threadId: string): boolean {
      return db.run("DELETE FROM thread_summaries WHERE thread_id = ?", threadId).changes > 0;
    },
  };
}

export type SummariesStore = ReturnType<typeof createSummariesStore>;
