/**
 * What every service gets: the store, the bus, the vault, the sync engine (bound late, because
 * the engine itself needs the services), and small helpers for the steps every write shares.
 */
import type { Activity, Actor, InvalidationTopic } from "@fancy-mail/contracts";

import type { DataPaths } from "../config.ts";
import { newId } from "../db/ids.ts";
import type { Db } from "../db/sqlite.ts";
import type { Logger } from "../log.ts";
import { toContractActivity } from "../store/activity.ts";
import type { Store } from "../store/index.ts";
import type { SyncEngine } from "../sync/types.ts";
import type { EventBus } from "./bus.ts";
import type { Vault } from "./vault.ts";

export interface ServiceEnv {
  db: Db;
  store: Store;
  bus: EventBus;
  vault: Vault;
  log: Logger;
  dataDir: string;
  paths: DataPaths;
  version: string;
  now: () => number;
  /** The sync engine; throws until one is attached. */
  sync: () => SyncEngine;
  /** The port the server listens on (for the MCP url); 0 until listening. */
  port: () => number;
}

export function invalidate(env: ServiceEnv, topics: InvalidationTopic[], threadIds?: string[]): void {
  const unique = [...new Set(topics)];
  if (threadIds && threadIds.length > 0) env.bus.publish({ type: "invalidate", topics: unique, threadIds: [...new Set(threadIds)] });
  else env.bus.publish({ type: "invalidate", topics: unique });
}

export interface NewActivity {
  actor: Actor;
  summary: string;
  kind: string;
  threadIds?: string[];
  accountIds?: string[];
  undo?: unknown | null;
  at?: number;
  isDemo?: boolean;
}

/** Writes an Activity row (inside the caller's transaction) and returns the contract shape. */
export function writeActivity(env: ServiceEnv, input: NewActivity): Activity {
  const record = {
    id: newId("act"),
    at: input.at ?? env.now(),
    actor: input.actor,
    summary: input.summary,
    kind: input.kind,
    threadIds: input.threadIds ?? [],
    accountIds: input.accountIds ?? [],
    undo: input.undo ?? null,
    undoneAt: null,
    undoneBy: null,
    isDemo: input.isDemo ?? false,
  };
  env.store.activity.insert(record);
  return toContractActivity(record);
}

/** Tells the sync engine about new outbox ops without letting its errors fail the write. */
export function notifyOutbox(env: ServiceEnv, accountIds: Iterable<string>): void {
  for (const accountId of new Set(accountIds)) {
    try {
      env.sync().notifyOutbox(accountId);
    } catch (error) {
      env.log.warn("could not notify the sync engine", { accountId, error });
    }
  }
}
