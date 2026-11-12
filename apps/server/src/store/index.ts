import type { Db } from "../db/sqlite.ts";
import { createAccountsStore } from "./accounts.ts";
import { createActivityStore, createOutboxStore } from "./activity.ts";
import { createDraftsStore, createUploadsStore } from "./drafts.ts";
import { createGroupsStore } from "./groups.ts";
import { createLabelsStore } from "./labels.ts";
import { createMailboxesStore } from "./mailboxes.ts";
import { createMessagesStore } from "./messages.ts";
import { createKvStore, createSettingsStore } from "./settings.ts";
import { createThreadStatesStore } from "./threadStates.ts";
import { createThreadsStore, refreshThreads } from "./threads.ts";

/** Every table's SQL, in one object. No business rules live here. */
export function createStore(db: Db) {
  return {
    db,
    accounts: createAccountsStore(db),
    groups: createGroupsStore(db),
    labels: createLabelsStore(db),
    mailboxes: createMailboxesStore(db),
    messages: createMessagesStore(db),
    threads: createThreadsStore(db),
    threadStates: createThreadStatesStore(db),
    drafts: createDraftsStore(db),
    uploads: createUploadsStore(db),
    activity: createActivityStore(db),
    outbox: createOutboxStore(db),
    settings: createSettingsStore(db),
    kv: createKvStore(db),
    refreshThreads: (threadIds: Iterable<string>) => refreshThreads(db, threadIds),
  };
}

export type Store = ReturnType<typeof createStore>;
