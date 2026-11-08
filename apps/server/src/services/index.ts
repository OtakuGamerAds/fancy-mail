/**
 * Everything the app can do. Transports (WebSocket, HTTP, MCP) call these and nothing else;
 * the sync engine calls back into the internal parts (account status, finished sends).
 */
import type { Bootstrap } from "@fancy-mail/contracts";

import { dataPaths } from "../config.ts";
import type { Db } from "../db/sqlite.ts";
import { removeDemo, seedDemo } from "../demo/seed.ts";
import type { SeedOptions, SeedSummary } from "../demo/seed.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import type { SyncEngine } from "../sync/types.ts";
import { AppError } from "../errors.ts";
import { createAccountsService } from "./accounts.ts";
import { createActivityService } from "./activity.ts";
import type { EventBus } from "./bus.ts";
import { requireUser } from "./context.ts";
import type { CallContext } from "./context.ts";
import { createDraftsService } from "./drafts.ts";
import { invalidate } from "./env.ts";
import type { ServiceEnv } from "./env.ts";
import { createAttachmentsService, createUploadsService } from "./files.ts";
import { createGroupsService } from "./groups.ts";
import { createLabelsService } from "./labels.ts";
import { createMcpService, createSettingsService } from "./settings.ts";
import { createThreadsService } from "./threads.ts";
import type { Vault } from "./vault.ts";

export type { CallContext } from "./context.ts";

export interface ServicesDeps {
  db: Db;
  store: Store;
  bus: EventBus;
  vault: Vault;
  log: Logger;
  dataDir: string;
  version: string;
  now?: () => number;
}

export function createServices(deps: ServicesDeps) {
  let sync: SyncEngine | null = null;
  let port = 0;
  const env: ServiceEnv = {
    db: deps.db,
    store: deps.store,
    bus: deps.bus,
    vault: deps.vault,
    log: deps.log,
    dataDir: deps.dataDir,
    paths: dataPaths(deps.dataDir),
    version: deps.version,
    now: deps.now ?? Date.now,
    sync: () => {
      if (!sync) throw new AppError("internal", "Mail sync isn't running yet. Try again in a moment.");
      return sync;
    },
    port: () => port,
  };

  const settings = createSettingsService(env);
  const threads = createThreadsService(env);
  const labels = createLabelsService(env);
  const groups = createGroupsService(env);
  const accounts = createAccountsService(env, () => settings.get());
  const drafts = createDraftsService(env);
  const attachments = createAttachmentsService(env);
  const uploads = createUploadsService(env);
  const activity = createActivityService(env, { labels, groups, drafts });
  const mcp = createMcpService(env);

  const demo = {
    seed(options: SeedOptions = {}): SeedSummary {
      const summary = seedDemo(env, options);
      return summary;
    },
    remove(ctx: CallContext): void {
      requireUser(ctx, "remove the demo accounts");
      const ids = removeDemo(env);
      for (const id of ids) {
        try {
          env.sync().accountRemoved(id);
        } catch {
          // The engine may not be attached (tests).
        }
      }
      invalidate(env, ["accounts", "groups", "labels", "mailboxes", "threads", "drafts", "activity"]);
    },
    reset(ctx: CallContext): void {
      requireUser(ctx, "reset the demo accounts");
      removeDemo(env);
      seedDemo(env);
      invalidate(env, ["accounts", "groups", "labels", "mailboxes", "threads", "drafts", "activity"]);
    },
    hasDemoData(): boolean {
      return deps.store.accounts.demoIds().length > 0;
    },
  };

  const services = {
    env,
    bus: deps.bus,
    store: deps.store,
    vault: deps.vault,
    settings,
    threads,
    labels,
    groups,
    accounts,
    drafts,
    attachments,
    uploads,
    activity,
    mcp,
    demo,

    bootstrap(): Bootstrap {
      return {
        version: deps.version,
        dataDir: deps.dataDir,
        accounts: accounts.list(),
        groups: groups.list(),
        labels: labels.list(),
        mailboxes: deps.store.mailboxes.listWithCounts(),
        settings: settings.get(),
        mcp: mcp.info(),
        hasDemoData: demo.hasDemoData(),
      };
    },

    /** Called once the sync engine exists (it needs the services first). */
    attachSync(engine: SyncEngine): void {
      sync = engine;
    },

    setPort(value: number): void {
      port = value;
    },
  };
  return services;
}

export type Services = ReturnType<typeof createServices>;
