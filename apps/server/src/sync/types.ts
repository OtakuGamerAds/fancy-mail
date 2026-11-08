/**
 * The seam between the app and the mail servers. Services call these methods; the engine calls
 * back into services (account status, finished sends) and the store (what it downloaded).
 *
 * The real engine (engine.ts) is the default: one worker per real account (worker.ts), with
 * demo accounts handed to the local-only engine (localOnly.ts). Tests may pass their own with
 * `createServer(config, { createSync })`.
 */
import type { ServerEndpoint } from "@fancy-mail/contracts";

import type { ServerConfig } from "../config.ts";
import type { Db } from "../db/sqlite.ts";
import type { Logger } from "../log.ts";
import type { EventBus } from "../services/bus.ts";
import type { Services } from "../services/index.ts";
import type { Vault } from "../services/vault.ts";
import type { Store } from "../store/index.ts";

export interface SyncEngine {
  start(): void;
  stop(): Promise<void>;
  /** Download these bodies soon (newest first); a `threads` invalidation follows. */
  requestBodies(messageIds: string[]): void;
  /** Resolves to a local path once the file is on this computer. */
  downloadAttachment(attachmentId: string): Promise<string>;
  /** New outbox ops were enqueued for this account. */
  notifyOutbox(accountId: string): void;
  syncNow(accountId?: string): void;
  /** Signs in to IMAP and SMTP and out again; throws an AppError written for a person. */
  testPasswordAccount(input: {
    email: string;
    username: string;
    password: string;
    imap: ServerEndpoint;
    smtp: ServerEndpoint;
  }): Promise<void>;
  accountAdded(accountId: string): void;
  accountRemoved(accountId: string): void;
  /** Paused/resumed, reconnected, settings changed. */
  accountUpdated(accountId: string): void;
  /** The draft is "queued"; finish with services.drafts.markSent / markSendFailed. */
  sendDraft(draftId: string): void;
  startOAuth(input: {
    provider: "google" | "microsoft";
    accountId?: string;
    groupId?: string | null;
  }): Promise<{ flowId: string; authUrl: string }>;
  cancelOAuth(flowId: string): void;
}

export interface SyncDeps {
  db: Db;
  store: Store;
  services: Services;
  bus: EventBus;
  vault: Vault;
  config: ServerConfig;
  log: Logger;
}

export type CreateSync = (deps: SyncDeps) => SyncEngine;
