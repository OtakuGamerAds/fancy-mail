import type { Activity } from "@fancy-mail/contracts";

import { AppError } from "../errors.ts";
import { toContractActivity } from "../store/activity.ts";
import { decodeCursor, encodeCursor } from "../search/compile.ts";
import { requireAccess, requireAnyAccess } from "./context.ts";
import type { CallContext } from "./context.ts";
import { invalidate } from "./env.ts";
import type { ServiceEnv } from "./env.ts";
import type { DraftsService, DraftUndo } from "./drafts.ts";
import type { GroupsService, GroupUndo } from "./groups.ts";
import type { LabelsService, LabelUndo } from "./labels.ts";
import { applyUndoSteps } from "./threads.ts";
import type { ModifyUndoRecord } from "./threads.ts";

type AnyUndo = ModifyUndoRecord | LabelUndo | GroupUndo | DraftUndo;

export function createActivityService(
  env: ServiceEnv,
  deps: { labels: LabelsService; groups: GroupsService; drafts: DraftsService },
) {
  const { store } = env;

  return {
    list(input: { cursor?: string | null; limit?: number }): { items: Activity[]; nextCursor: string | null } {
      const limit = Math.max(1, Math.min(200, input.limit ?? 50));
      let before: { at: number; id: string } | null = null;
      if (input.cursor) {
        before = decodeCursor(input.cursor);
        if (!before) throw new AppError("bad_request", "That page cursor isn't valid. Load the list again without a cursor.");
      }
      const rows = store.activity.page(before, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toContractActivity),
        nextCursor: rows.length > limit && last ? encodeCursor(last.at, last.id) : null,
      };
    },

    get(id: string): Activity {
      const record = store.activity.get(id);
      if (!record) throw new AppError("not_found", `No activity with id ${id}.`);
      return toContractActivity(record);
    },

    /** Puts things back as they were before that change; the entry is marked undone. */
    undo(id: string, ctx: CallContext): Activity {
      const record = store.activity.get(id);
      if (!record) throw new AppError("not_found", `No activity with id ${id}.`);
      if (record.undoneAt !== null) throw new AppError("conflict", "That change was already undone.");
      if (record.undo === null) throw new AppError("bad_request", `"${record.summary}" can't be undone.`);
      const undo = record.undo as AnyUndo;

      // Agents need the same access the change itself needed.
      if (ctx.actor.kind === "agent") {
        const accounts = record.accountIds.map((aid) => store.accounts.get(aid)).filter((a) => a !== null);
        if (undo.type === "modify" || undo.type === "groupAssign" || undo.type === "groupDelete") {
          for (const a of accounts) requireAccess(ctx, a, "organize", "undoing this change");
        } else if (undo.type === "draftCreate") {
          for (const a of accounts) requireAccess(ctx, a, "draft", "undoing this draft");
        } else {
          requireAnyAccess(ctx, store.accounts.list(), "organize", "Undoing label and group changes");
        }
      }

      let threadIds: string[] = [];
      switch (undo.type) {
        case "modify":
          threadIds = applyUndoSteps(env, undo.steps).threadIds;
          break;
        case "labelCreate":
        case "labelUpdate":
        case "labelDelete":
          threadIds = deps.labels.undo(undo);
          break;
        case "groupCreate":
        case "groupUpdate":
        case "groupDelete":
        case "groupAssign":
          deps.groups.undo(undo);
          break;
        case "draftCreate":
          threadIds = deps.drafts.undo(undo);
          break;
        default:
          throw new AppError("bad_request", `"${record.summary}" can't be undone.`);
      }

      const at = env.now();
      store.activity.markUndone(record.id, at, ctx.actor);
      const activity = toContractActivity({ ...record, undoneAt: at, undoneBy: ctx.actor });
      invalidate(env, ["activity"], threadIds.length > 0 && threadIds.length < 1000 ? threadIds : undefined);
      env.bus.publish({ type: "activity", activity });
      return activity;
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
