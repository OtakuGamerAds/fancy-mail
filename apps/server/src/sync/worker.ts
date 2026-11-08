/**
 * One real account's sync: a small state machine around one IMAP connection.
 *
 *   idle → connecting → syncing → ready ⟲ (IDLE, a pass every 3 minutes and on every change)
 *                ↘ offline        network or server trouble: retry after 5 s, 15 s, 30 s, 1 min,
 *                                 2 min, then every 5 min — and right away on "Sync now"
 *                ↘ auth-required  the server refused the credentials: stop, keep them and the
 *                                 mail, wait until the account is reconnected
 *   paused                        the person paused the account
 *
 * While connected, one loop runs one job at a time, most urgent first: attachment downloads,
 * bodies someone is looking at, local changes (the outbox), a sync pass, then prefetching bodies.
 * A long first sync yields to the urgent jobs between batches, so opening a message never waits
 * for 8,000 headers.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

import type { AccountStatus, AccountSyncState, MailboxRole, Settings } from "@fancy-mail/contracts";
import type { FetchMessageObject, FetchQueryObject, ImapFlow, MailboxObject } from "imapflow";

import type { ServerConfig } from "../config.ts";
import { newId } from "../db/ids.ts";
import type { Db } from "../db/sqlite.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { EventBus } from "../services/bus.ts";
import type { Services } from "../services/index.ts";
import type { Vault } from "../services/vault.ts";
import type { OutboxMessageChange, OutboxPayload } from "../store/activity.ts";
import type { Store } from "../store/index.ts";
import type { AccountRecord, MailboxRecord, MessageRecord, OutboxRecord } from "../store/types.ts";
import { parseSource, storeParsedBody } from "./bodies.ts";
import { classifyError, isAuthError, isNetworkError } from "./errors.ts";
import type { HeaderInfo } from "./headers.ts";
import { headerInfo } from "./headers.ts";
import { createImapClient } from "./imap.ts";
import type { ImapAuth } from "./imap.ts";
import { keywordsAllowed, labelToKeyword, labelsFromFlags } from "./keywords.ts";
import { GMAIL_VIRTUAL_ROLES, planMailboxes, reconcileMailboxes, splitGmailLabels } from "./mailboxes.ts";
import type { ServerMailbox } from "./mailboxes.ts";
import type { OAuth } from "./oauth.ts";
import { MAX_OP_ATTEMPTS, failedOpsMessage, groupCommands, planGmailChange, planImapChange, reconnectDelayMs, retryDelayMs } from "./outbox.ts";
import type { ImapCommand, ServerCopy } from "./outbox.ts";
import { Semaphore, Signal } from "./signal.ts";
import type { SyncStore } from "./syncStore.ts";
import { ThreadIndex } from "./threading.ts";
import type { ThreadCandidate } from "./threading.ts";

const BATCH = 250;
const PASS_INTERVAL_MS = 3 * 60_000;
const IDLE_DEBOUNCE_MS = 2_000;
const UID_CHECK_EVERY = 5;
const FLAG_CHECK_WINDOW = 1_000;
const BODY_BATCH = 10;
const MAX_BODY_TRIES = 3;
const PREFETCH_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_WAIT_MS = 120_000;
const HEALTHY_SESSION_MS = 60_000;

export interface WorkerDeps {
  db: Db;
  store: Store;
  syncStore: SyncStore;
  services: Services;
  bus: EventBus;
  vault: Vault;
  config: ServerConfig;
  log: Logger;
  oauth: OAuth;
  initialSlots: Semaphore;
  settings: () => Settings;
}

interface MailboxSyncState {
  initialDone?: boolean;
  backfillCursor?: number | null;
  lastExists?: number;
  passes?: number;
}

interface AccountSyncInfo {
  initialDone?: boolean;
  gmail?: boolean;
  lastPassAt?: number;
}

/** The secret could not be read (vault key changed): the person has to enter it again. */
class MissingSecretError extends Error {
  constructor() {
    super("missing secret");
    this.name = "MissingSecretError";
  }
}

/** The connection went away while a job ran: end the session, reconnect. */
class ConnectionLost extends Error {
  constructor(cause?: unknown) {
    super("connection lost");
    this.name = "ConnectionLost";
    this.cause = cause;
  }
}

interface PassContext {
  initial: boolean;
  /** Messages with local changes on the way: the server's view of them is not applied yet. */
  protected: Set<string>;
  newInbox: Set<string>;
  newMessages: string[];
  touched: Set<string>;
  labelsChanged: boolean;
}

function fingerprint(value: string | null): string {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : "";
}

function asNumber(value: bigint | number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  return Number(value);
}

function minOf(values: Iterable<number>): number | null {
  let out: number | null = null;
  for (const v of values) if (out === null || v < out) out = v;
  return out;
}

function maxOf(values: Iterable<number>): number | null {
  let out: number | null = null;
  for (const v of values) if (out === null || v > out) out = v;
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export class AccountWorker {
  readonly accountId: string;
  readonly #deps: WorkerDeps;
  readonly #log: Logger;
  #stopped = false;
  #running: Promise<void> | null = null;
  #client: ImapFlow | null = null;
  #gmail = false;
  #lastStatus = "";
  #state: AccountSyncState = "idle";
  #failures = 0;
  #authBlocked: string | null = null;
  /** Wakes the backoff wait (Sync now, reconnect, unpause). */
  readonly #reconnect = new Signal();
  /** Wakes the job loop. */
  readonly #work = new Signal();
  #wantPass = false;
  #wantOutbox = true;
  #busy = false;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  readonly #urgentBodies = new Map<string, number>();
  #prefetch: string[] = [];
  readonly #attachments = new Map<string, { resolve: (p: string) => void; reject: (e: Error) => void }[]>();
  readonly #uidCheck = new Set<string>();
  readonly #vanished = new Map<string, Set<number>>();
  readonly #movedTo = new Map<string, Map<string, number>>();
  readonly #keywordsOk = new Map<string, boolean>();
  #serverPaths = new Set<string>();
  #index: ThreadIndex | null = null;
  readonly #gmThreads = new Map<string, string>();
  #passes = 0;

  constructor(accountId: string, deps: WorkerDeps) {
    this.accountId = accountId;
    this.#deps = deps;
    this.#log = deps.log.child(accountId);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.#running) return;
    this.#stopped = false;
    this.#running = this.#run().catch((error) => this.#log.error("worker crashed", { error }));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#reconnect.notify();
    this.#work.notify();
    const client = this.#client;
    if (client) {
      await Promise.race([client.logout().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
      client.close();
    }
    for (const [, waiters] of this.#attachments) for (const w of waiters) w.reject(new AppError("connection_failed", "The account was stopped before the attachment arrived."));
    this.#attachments.clear();
    await this.#running;
    this.#running = null;
  }

  get state(): AccountSyncState {
    return this.#state;
  }

  get connected(): boolean {
    return this.#client?.usable === true;
  }

  get isGmail(): boolean {
    return this.#gmail || this.#deps.store.mailboxes.byRole(this.accountId, "all") !== null;
  }

  /** The account changed (paused, resumed, reconnected, settings). */
  updated(): void {
    const account = this.#deps.store.accounts.get(this.accountId);
    if (!account) return;
    if (account.paused) {
      this.#client?.close();
      this.#reconnect.notify();
      this.#work.notify();
      return;
    }
    if (this.#authBlocked !== null && this.#authBlocked !== this.#secretFingerprint(account)) {
      this.#authBlocked = null;
      this.#failures = 0;
    }
    if (this.#state === "paused" || this.#state === "offline" || this.#state === "auth-required" || this.#state === "error") {
      this.#reconnect.notify();
    }
  }

  syncNow(): void {
    const retried = this.#deps.syncStore.retryFailed(this.accountId);
    if (retried > 0) this.#wantOutbox = true;
    if (this.#authBlocked !== null) this.#authBlocked = null;
    this.#failures = 0;
    this.#wantPass = true;
    this.#reconnect.notify();
    this.#work.notify();
  }

  /** A pass soon, without retrying failed changes (after a send). */
  syncNowQuiet(): void {
    this.#wantPass = true;
    this.#work.notify();
  }

  notifyOutbox(): void {
    this.#wantOutbox = true;
    this.#work.notify();
  }

  requestBodies(messageIds: string[]): void {
    const messages = this.#deps.store.messages.byIds(messageIds);
    for (const m of messages) {
      if (m.bodyState === "ready") continue;
      this.#urgentBodies.set(m.id, m.date);
    }
    if (messages.length > 0) this.#work.notify();
  }

  downloadAttachment(attachmentId: string): Promise<string> {
    if (this.#state === "auth-required") {
      return Promise.reject(new AppError("auth_failed", "This account needs to be reconnected before the attachment can be downloaded."));
    }
    if (this.#state === "paused") {
      return Promise.reject(new AppError("connection_failed", "This account is paused. Resume it to download the attachment."));
    }
    if (this.#state === "offline" || this.#state === "error") {
      return Promise.reject(new AppError("connection_failed", "Fancy Mail can't reach the mail server right now, so the attachment can't be downloaded. It works again once the account is back online."));
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const list = this.#attachments.get(attachmentId)?.filter((w) => w.resolve !== done);
        if (list && list.length > 0) this.#attachments.set(attachmentId, list);
        else this.#attachments.delete(attachmentId);
        reject(new AppError("connection_failed", "Downloading the attachment took too long. Try again."));
      }, ATTACHMENT_WAIT_MS);
      const done = (p: string) => {
        clearTimeout(timer);
        resolve(p);
      };
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      const list = this.#attachments.get(attachmentId) ?? [];
      list.push({ resolve: done, reject: fail });
      this.#attachments.set(attachmentId, list);
      this.#work.notify();
    });
  }

  /** Our own sent message was stored: rebuild the threading index before the next use. */
  resetIndex(): void {
    this.#index = null;
  }

  /** APPENDs a message (the Sent copy) with the live connection. Null when not connected. */
  async append(path: string, raw: Buffer, flags: string[]): Promise<{ uid: number | null } | null> {
    const client = this.#client;
    if (!client?.usable) return null;
    const result = await client.append(path, raw, flags);
    return { uid: result && typeof result.uid === "number" ? result.uid : null };
  }

  // ── Status ────────────────────────────────────────────────────────────────────────────────

  #setStatus(state: AccountSyncState, message: string | null, progress: AccountStatus["progress"] = null, lastSyncAt?: number): void {
    this.#state = state;
    const account = this.#deps.store.accounts.get(this.accountId);
    if (!account) return;
    const status: AccountStatus = { state, message, progress, lastSyncAt: lastSyncAt ?? account.status.lastSyncAt };
    const key = JSON.stringify(status);
    if (key === this.#lastStatus) return;
    this.#lastStatus = key;
    this.#deps.services.accounts.setStatus(this.accountId, status);
  }

  #setReady(lastSyncAt?: number): void {
    this.#setStatus("ready", failedOpsMessage(this.#deps.syncStore.failedCount(this.accountId)), null, lastSyncAt);
  }

  // ── Connection loop ───────────────────────────────────────────────────────────────────────

  #secretFingerprint(account: AccountRecord): string {
    const kind = account.authKind === "password" ? "password" : "oauth-refresh";
    return `${account.authKind}:${fingerprint(this.#deps.vault.get(account.id, kind))}`;
  }

  async #credentials(account: AccountRecord): Promise<ImapAuth> {
    const user = account.username || account.email;
    if (account.authKind === "password") {
      const pass = this.#deps.vault.get(account.id, "password");
      if (!pass) throw new MissingSecretError();
      this.#log.addSecret(pass);
      return { user, pass };
    }
    if (account.authKind === "oauth-google" || account.authKind === "oauth-microsoft") {
      if (!this.#deps.vault.has(account.id, "oauth-refresh")) throw new MissingSecretError();
      return { user, accessToken: await this.#deps.oauth.accessToken(account) };
    }
    throw new MissingSecretError();
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      const account = this.#deps.store.accounts.get(this.accountId);
      if (!account) return;
      if (account.paused) {
        this.#setStatus("paused", "Paused");
        await this.#reconnect.wait(Infinity);
        continue;
      }
      if (this.#authBlocked !== null) {
        await this.#reconnect.wait(Infinity);
        continue;
      }
      if (!account.imap) {
        this.#setStatus("error", "This account has no incoming mail server set. Remove it and add it again.");
        await this.#reconnect.wait(Infinity);
        continue;
      }
      const startedAt = Date.now();
      const pausedNow = () => this.#deps.store.accounts.get(this.accountId)?.paused === true;
      try {
        await this.#session(account);
        if (this.#stopped) return;
        if (pausedNow()) continue;
        // The server closed the connection: come back soon.
        if (Date.now() - startedAt > HEALTHY_SESSION_MS) this.#failures = 0;
        this.#setStatus("offline", `Lost the connection to ${account.imap.host} — reconnecting…`);
      } catch (error) {
        if (this.#stopped) return;
        if (pausedNow()) continue;
        if (Date.now() - startedAt > HEALTHY_SESSION_MS) this.#failures = 0;
        if (await this.#handleSessionError(account, error)) continue;
      }
      const delay = reconnectDelayMs(this.#failures);
      this.#failures++;
      await this.#reconnect.wait(delay);
    }
  }

  /** Returns true to retry right away (a stale OAuth token was refreshed). */
  async #handleSessionError(account: AccountRecord, error: unknown): Promise<boolean> {
    const host = account.imap?.host ?? "the mail server";
    if (error instanceof MissingSecretError) {
      this.#authBlocked = this.#secretFingerprint(account);
      this.#setStatus(
        "auth-required",
        account.authKind === "password"
          ? "The saved password can't be read on this computer any more. Reconnect and enter it again; your mail stays here."
          : "The saved sign-in can't be read on this computer any more. Sign in again; your mail stays here.",
      );
      return false;
    }
    const cause = error instanceof ConnectionLost ? (error.cause ?? error) : error;
    if (isAuthError(cause) && !(error instanceof ConnectionLost)) {
      if (account.authKind !== "password" && !this.#retriedToken) {
        // The access token may have expired early: refresh once before asking the person.
        this.#retriedToken = true;
        this.#deps.oauth.invalidateToken(account.id);
        return true;
      }
      this.#retriedToken = false;
      const classified = classifyError(cause, { host, provider: account.provider, mode: "background", protocol: account.authKind === "password" ? "imap" : "oauth", email: account.email });
      this.#authBlocked = this.#secretFingerprint(account);
      this.#log.warn("sign-in refused", { host });
      this.#setStatus("auth-required", classified.message);
      return false;
    }
    this.#retriedToken = false;
    const classified = classifyError(cause, { host, provider: account.provider, mode: "background", protocol: "imap", email: account.email });
    if (classified.kind === "network" || error instanceof ConnectionLost) {
      this.#log.info("offline", { host, error: cause instanceof Error ? cause.message : String(cause) });
      this.#setStatus("offline", classified.kind === "network" ? classified.message : `Lost the connection to ${host} — will keep trying.`);
    } else {
      this.#log.warn("sync failed", { host, error: cause instanceof Error ? cause.message : String(cause) });
      this.#setStatus("offline", `${classified.message} — will keep trying.`);
    }
    return false;
  }

  #retriedToken = false;

  async #session(account: AccountRecord): Promise<void> {
    this.#setStatus("connecting", "Connecting…");
    const auth = await this.#credentials(account);
    const client = createImapClient(account.imap!, auth, this.#log);
    let closed = false;
    client.on("close", () => {
      closed = true;
      this.#work.notify();
    });
    client.on("exists", (ev: { path: string; count: number }) => {
      this.#log.debug("exists", { path: ev.path, count: ev.count, busy: this.#busy });
      if (ev.path === this.#idlePath()) this.#scheduleIdlePass();
    });
    client.on("expunge", (ev: { path: string; uid?: number; vanished?: boolean; seq?: number }) => {
      this.#log.debug("expunge", { path: ev.path, seq: ev.seq, uid: ev.uid, vanished: ev.vanished });
      if (ev.uid !== undefined && ev.vanished) {
        let set = this.#vanished.get(ev.path);
        if (!set) this.#vanished.set(ev.path, (set = new Set()));
        set.add(ev.uid);
      } else {
        this.#uidCheck.add(ev.path);
      }
      if (!this.#busy) this.#scheduleIdlePass();
    });
    client.on("flags", () => {
      if (!this.#busy) this.#scheduleIdlePass();
    });
    try {
      await client.connect();
    } catch (error) {
      client.close();
      throw error;
    }
    if (this.#stopped) {
      client.close();
      return;
    }
    this.#retriedToken = false;
    this.#client = client;
    this.#gmail = client.capabilities.has("X-GM-EXT-1");
    this.#deps.syncStore.makeDueNow(this.accountId);
    this.#wantOutbox = true;
    this.#log.info("connected", { gmail: this.#gmail, condstore: this.#condstore() });
    try {
      await this.#serve(client, () => closed);
    } catch (error) {
      if (closed || !client.usable) throw new ConnectionLost(error);
      throw error;
    } finally {
      this.#client = null;
      if (!closed) {
        if (this.#stopped) await Promise.race([client.logout().catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
        client.close();
      }
      // Work that needs a connection can't finish now.
      for (const [, waiters] of this.#attachments) {
        for (const w of waiters) w.reject(new AppError("connection_failed", "The connection to the mail server dropped. Try again in a moment."));
      }
      this.#attachments.clear();
    }
  }

  #condstore(): boolean {
    const c = this.#client;
    return !!c && (c.enabled.has("CONDSTORE") || c.enabled.has("QRESYNC") || c.capabilities.has("CONDSTORE"));
  }

  #idlePath(): string {
    if (this.#gmail) return this.#deps.store.mailboxes.byRole(this.accountId, "all")?.path ?? "INBOX";
    return "INBOX";
  }

  #scheduleIdlePass(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      this.#wantPass = true;
      this.#work.notify();
    }, IDLE_DEBOUNCE_MS);
  }

  async #serve(client: ImapFlow, isClosed: () => boolean): Promise<void> {
    const syncInfo = (this.#deps.store.accounts.getSyncState(this.accountId) ?? {}) as AccountSyncInfo;
    await this.#refreshMailboxes(client);
    if (syncInfo.gmail !== this.#gmail) this.#saveSyncInfo({ gmail: this.#gmail });
    await this.#drainOutbox(client);
    if (!syncInfo.initialDone) {
      await this.#initialSync(client);
    } else {
      this.#setStatus("syncing", "Checking for new mail…");
      await this.#pass(client, false);
    }
    this.#failures = 0;
    this.#setReady(Date.now());
    let nextPass = Date.now() + PASS_INTERVAL_MS;
    await this.#selectIdle(client);

    while (!this.#stopped && !isClosed() && client.usable) {
      const account = this.#deps.store.accounts.get(this.accountId);
      if (!account || account.paused) return;
      if (Date.now() >= nextPass) this.#wantPass = true;
      const job = this.#nextJob(client);
      if (job) {
        this.#busy = true;
        try {
          await job();
        } finally {
          this.#busy = false;
        }
        if (this.#wantPassWasRun) {
          this.#wantPassWasRun = false;
          nextPass = Date.now() + PASS_INTERVAL_MS;
        }
        if (!this.#hasWork()) await this.#selectIdle(client);
        continue;
      }
      await this.#work.wait(Math.max(1_000, nextPass - Date.now()));
    }
  }

  #wantPassWasRun = false;

  #hasWork(): boolean {
    return (
      this.#attachments.size > 0 ||
      this.#urgentBodies.size > 0 ||
      this.#wantOutbox ||
      this.#wantPass ||
      this.#prefetch.length > 0
    );
  }

  #nextJob(client: ImapFlow): (() => Promise<void>) | null {
    if (this.#attachments.size > 0) return () => this.#runAttachments(client);
    if (this.#urgentBodies.size > 0) return () => this.#runUrgentBodies(client);
    if (this.#wantOutbox) return () => this.#drainOutbox(client);
    if (this.#wantPass) {
      return async () => {
        this.#wantPass = false;
        this.#wantPassWasRun = true;
        await this.#pass(client, false);
        this.#setReady(Date.now());
      };
    }
    if (this.#prefetch.length > 0) return () => this.#runPrefetch(client);
    return null;
  }

  /** Between batches of a long sync: what someone is waiting for goes first. */
  async #yieldUrgent(client: ImapFlow): Promise<void> {
    if (!client.usable) throw new ConnectionLost();
    if (this.#stopped) throw new ConnectionLost();
    if (this.#attachments.size > 0) await this.#runAttachments(client);
    if (this.#urgentBodies.size > 0) await this.#runUrgentBodies(client);
    if (this.#wantOutbox) await this.#drainOutbox(client);
  }

  async #selectIdle(client: ImapFlow): Promise<void> {
    if (!client.usable) return;
    const path = this.#idlePath();
    try {
      const lock = await client.getMailboxLock(path);
      lock.release();
      // Mail that arrived during the pass, after this mailbox was looked at, is in the SELECT's
      // counts and will never come as an EXISTS: compare with what the pass recorded.
      const mb = client.mailbox;
      const row = this.#deps.store.mailboxes.byPath(this.accountId, path);
      if (mb && row && row.uidnext !== null) {
        const state = (row.sync ?? {}) as MailboxSyncState;
        const newer =
          mb.uidNext > row.uidnext ||
          (state.lastExists !== undefined && mb.exists !== state.lastExists) ||
          (mb.highestModseq !== undefined && row.highestmodseq !== null && mb.highestModseq > BigInt(row.highestmodseq));
        if (newer) this.#scheduleIdlePass();
      }
    } catch (error) {
      this.#log.debug("could not select the idle mailbox", { path, error: (error as Error).message });
    }
  }

  // ── Mailboxes ─────────────────────────────────────────────────────────────────────────────

  async #refreshMailboxes(client: ImapFlow): Promise<void> {
    const list = await client.list();
    // A LIST without INBOX is a broken answer: never remove folders (and their mail) because of it.
    if (!list.some((m) => m.path.toUpperCase() === "INBOX")) {
      this.#log.warn("the folder list had no INBOX; keeping the folders as they are");
      for (const m of list) this.#serverPaths.add(m.path);
      return;
    }
    this.#serverPaths = new Set(list.map((m) => m.path));
    const server: ServerMailbox[] = list.map((m) => ({
      path: m.path,
      name: m.name,
      delimiter: m.delimiter ?? null,
      specialUse: m.specialUse ?? null,
      specialUseSource: m.specialUseSource ?? null,
      flags: [...m.flags],
    }));
    const planned = planMailboxes(server, this.#gmail);
    const result = reconcileMailboxes(this.#deps.store, this.accountId, planned);
    if (result.removed.length > 0) this.#cleanupOrphans();
    if (result.changed) this.#deps.bus.publish({ type: "invalidate", topics: ["mailboxes", "threads", "accounts"] });
  }

  /** The mailboxes messages are fetched from, inbox first. */
  #syncedMailboxes(): MailboxRecord[] {
    const all = this.#deps.store.mailboxes.list(this.accountId).filter((m) => m.selectable && !m.createdLocally && this.#serverPaths.has(m.path));
    const synced = this.#gmail ? all.filter((m) => m.role === "all" || m.role === "trash" || m.role === "spam") : all;
    const order: Record<string, number> = { inbox: 0, all: 0, sent: 1, archive: 2, drafts: 3, spam: 5, trash: 6 };
    return synced.sort((a, b) => (order[a.role ?? ""] ?? 4) - (order[b.role ?? ""] ?? 4) || a.path.localeCompare(b.path));
  }

  // ── Passes ────────────────────────────────────────────────────────────────────────────────

  #newContext(initial: boolean): PassContext {
    return {
      initial,
      protected: this.#deps.syncStore.pendingMessageIds(this.accountId),
      newInbox: new Set(),
      newMessages: [],
      touched: new Set(),
      labelsChanged: false,
    };
  }

  #headerQuery(): FetchQueryObject {
    const q: FetchQueryObject = { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, headers: ["references"] };
    if (this.#gmail) {
      q.labels = true;
      q.threadId = true;
      q.emailId = true;
    }
    return q;
  }

  async #initialSync(client: ImapFlow): Promise<void> {
    let release: (() => void) | null = null;
    if (this.#deps.initialSlots.available <= 0) this.#setStatus("syncing", "Waiting…");
    const stopWait = new Promise<null>((resolve) => {
      const check = setInterval(() => {
        if (this.#stopped || !client.usable) {
          clearInterval(check);
          resolve(null);
        }
      }, 1000);
      void this.#deps.initialSlots.acquire(() => this.#stopped || !client.usable).then((r) => {
        clearInterval(check);
        release = r;
        resolve(null);
      });
    });
    await stopWait;
    if (!release) throw new ConnectionLost();
    try {
      this.#setStatus("syncing", "Looking at your folders…");
      const settings = this.#deps.settings();
      const since = settings.sync.initialDays > 0 ? new Date(Date.now() - settings.sync.initialDays * 24 * 3600_000) : null;
      // Plan: what each mailbox still needs (a restarted first sync skips what it has).
      const plans: { mailbox: MailboxRecord; uids: number[]; info: MailboxObject; reset: boolean }[] = [];
      for (const mailbox of this.#syncedMailboxes()) {
        const planned = await this.#planInitialMailbox(client, mailbox, since);
        if (planned) plans.push({ mailbox, ...planned });
      }
      const total = plans.reduce((n, p) => n + p.uids.length, 0);
      let done = 0;
      const ctx = this.#newContext(true);
      const progress = () => {
        if (total > 0) this.#setStatus("syncing", `Downloading ${fmt(done)} of ${fmt(total)}`, { done, total });
      };
      progress();
      for (const plan of plans) {
        for (let i = 0; i < plan.uids.length; i += BATCH) {
          const slice = plan.uids.slice(i, i + BATCH);
          await this.#fetchAndStore(client, plan.mailbox, slice, ctx);
          done += slice.length;
          progress();
          this.#flush(ctx);
          await this.#yieldUrgent(client);
        }
        this.#finishMailbox(plan.mailbox, plan.info, plan.uids, plan.reset);
      }
      this.#cleanupOrphans();
      this.#flush(ctx);
      this.#saveSyncInfo({ initialDone: true, lastPassAt: Date.now() });
      this.#queuePrefetch();
    } finally {
      (release as (() => void) | null)?.();
    }
  }

  /** Opens a mailbox for its first sync: which uids to fetch, newest first. */
  async #planInitialMailbox(client: ImapFlow, mailbox: MailboxRecord, since: Date | null): Promise<{ uids: number[]; info: MailboxObject; reset: boolean } | null> {
    const lock = await client.getMailboxLock(mailbox.path);
    try {
      const info = client.mailbox as MailboxObject;
      this.#keywordsOk.set(mailbox.path, keywordsAllowed(info.permanentFlags));
      const uidValidity = asNumber(info.uidValidity);
      const state = (mailbox.sync ?? {}) as MailboxSyncState & { resetPending?: boolean };
      let reset = state.resetPending === true;
      if (mailbox.uidvalidity !== null && mailbox.uidvalidity !== uidValidity) {
        this.#log.warn("UIDVALIDITY changed: resyncing the mailbox", { path: mailbox.path });
        this.#deps.syncStore.clearUids(mailbox.id);
        this.#deps.store.mailboxes.update(mailbox.id, { uidvalidity: uidValidity, highestmodseq: null, sync: { ...state, initialDone: false, resetPending: true } });
        reset = true;
      }
      if (info.exists === 0) return { uids: [], info, reset };
      const found = await client.search(since ? { since } : { all: true }, { uid: true });
      const known = this.#deps.syncStore.uidMap(mailbox.id);
      const uids = (Array.isArray(found) ? found : []).filter((u) => !known.has(u)).sort((a, b) => b - a);
      return { uids, info, reset };
    } finally {
      lock.release();
    }
  }

  /** Records that a mailbox's first sync (or resync) finished. */
  #finishMailbox(mailbox: MailboxRecord, info: MailboxObject, uids: number[], reset: boolean): void {
    const fresh = this.#deps.store.mailboxes.get(mailbox.id);
    if (!fresh) return;
    // After a UIDVALIDITY reset, locations that were not found again are gone from the server.
    if (reset) {
      const dropped = this.#deps.syncStore.dropLocationsWithoutUid(mailbox.id);
      if (dropped.length > 0) this.#deps.store.refreshThreads(this.#deps.store.messages.byIds(dropped).map((m) => m.threadId));
    }
    const known = this.#deps.syncStore.uidMap(mailbox.id);
    const lowest = minOf(uids.length > 0 ? uids : known.keys());
    const sync: MailboxSyncState & { resetPending?: boolean } = {
      ...(fresh.sync as MailboxSyncState | null),
      initialDone: true,
      resetPending: false,
      backfillCursor: lowest,
      lastExists: info.exists,
      passes: 0,
    };
    this.#deps.store.mailboxes.update(mailbox.id, {
      uidvalidity: asNumber(info.uidValidity),
      uidnext: info.uidNext,
      highestmodseq: info.highestModseq !== undefined ? String(info.highestModseq) : null,
      sync: sync as Record<string, unknown>,
    });
  }

  /** A regular pass: local changes up, then new mail, changed flags and deletions down. */
  async #pass(client: ImapFlow, initial: boolean): Promise<void> {
    this.#passes++;
    if (this.#passes % 5 === 0) await this.#refreshMailboxes(client);
    await this.#drainOutbox(client);
    const ctx = this.#newContext(initial);
    for (const mailbox of this.#syncedMailboxes()) {
      await this.#syncMailbox(client, mailbox, ctx);
      this.#flush(ctx);
      await this.#yieldUrgent(client);
    }
    this.#cleanupOrphans();
    this.#flush(ctx);
    if (ctx.newMessages.length > 0) this.#log.info("new mail", { messages: ctx.newMessages.length, newInInbox: ctx.newInbox.size });
    if (ctx.newInbox.size > 0) {
      const threadIds = [...new Set(this.#deps.store.messages.byIds([...ctx.newInbox]).map((m) => m.threadId))];
      this.#deps.bus.publish({ type: "newMail", accountId: this.accountId, threadIds, count: ctx.newInbox.size });
    }
    if (ctx.newMessages.length > 0) this.#queuePrefetch(ctx.newMessages);
    this.#saveSyncInfo({ lastPassAt: Date.now() });
  }

  async #syncMailbox(client: ImapFlow, mailbox: MailboxRecord, ctx: PassContext): Promise<void> {
    const fresh = this.#deps.store.mailboxes.get(mailbox.id);
    if (!fresh) return;
    const state = (fresh.sync ?? {}) as MailboxSyncState;
    // A folder that appeared after the first sync, or a reset one: sync it like the first time.
    if (fresh.uidnext === null || !state.initialDone) {
      const settings = this.#deps.settings();
      const since = settings.sync.initialDays > 0 ? new Date(Date.now() - settings.sync.initialDays * 24 * 3600_000) : null;
      const plan = await this.#planInitialMailbox(client, fresh, since);
      if (!plan) return;
      const sub = { ...ctx, initial: true };
      for (let i = 0; i < plan.uids.length; i += BATCH) {
        await this.#fetchAndStore(client, fresh, plan.uids.slice(i, i + BATCH), sub);
        this.#flush(sub);
        await this.#yieldUrgent(client);
      }
      this.#finishMailbox(fresh, plan.info, plan.uids, plan.reset);
      return;
    }

    // The mailbox we IDLE in stays selected: its UIDNEXT and HIGHESTMODSEQ from the SELECT are
    // old by now. A STATUS refreshes them (imapflow updates the live mailbox from it).
    const current = client.mailbox;
    const wasSelected = current !== false && current.path === fresh.path;
    const lock = await client.getMailboxLock(fresh.path);
    let resync = false;
    try {
      if (wasSelected) {
        await client.status(fresh.path, { uidNext: true, messages: true, uidValidity: true, highestModseq: this.#condstore() });
      }
      const info = client.mailbox as MailboxObject;
      this.#keywordsOk.set(fresh.path, keywordsAllowed(info.permanentFlags));
      const uidValidity = asNumber(info.uidValidity);
      if (fresh.uidvalidity !== null && uidValidity !== fresh.uidvalidity) {
        // The first-sync path notices the new UIDVALIDITY, forgets the old uids and refetches.
        this.#deps.store.mailboxes.update(fresh.id, { sync: { ...state, initialDone: false } });
        resync = true;
        return;
      }

      // New messages.
      const lastNext = fresh.uidnext ?? 1;
      if (info.uidNext > lastNext && info.exists > 0) {
        const found = await client.search({ uid: `${lastNext}:*` }, { uid: true });
        const known = this.#deps.syncStore.uidMap(fresh.id);
        const uids = (Array.isArray(found) ? found : []).filter((u) => u >= lastNext && !known.has(u)).sort((a, b) => b - a);
        for (let i = 0; i < uids.length; i += BATCH) {
          await this.#fetchHeadersLocked(client, fresh, uids.slice(i, i + BATCH), ctx);
        }
      }

      // Changed flags and labels.
      const highest = info.highestModseq !== undefined ? info.highestModseq : null;
      if (lastNext > 1) {
        if (this.#condstore() && !info.noModseq && highest !== null) {
          if (fresh.highestmodseq === null || BigInt(fresh.highestmodseq) < highest) {
            const changedSince = fresh.highestmodseq !== null ? BigInt(fresh.highestmodseq) : 1n;
            const query: FetchQueryObject = { uid: true, flags: true };
            if (this.#gmail) query.labels = true;
            const changed = await client.fetchAll(`1:${lastNext - 1}`, query, { uid: true, changedSince });
            this.#applyChanges(fresh, changed, ctx);
          }
        } else {
          const newest = this.#deps.syncStore.newestUids(fresh.id, FLAG_CHECK_WINDOW);
          if (newest.length > 0) {
            const query: FetchQueryObject = { uid: true, flags: true };
            if (this.#gmail) query.labels = true;
            const changed = await client.fetchAll(`${minOf(newest)}:${maxOf(newest)}`, query, { uid: true });
            this.#applyChanges(fresh, changed, ctx);
          }
        }
      }

      // Deletions: VANISHED (QRESYNC), or a uid comparison every few passes or when the count dropped.
      const vanished = this.#vanished.get(fresh.path);
      if (vanished && vanished.size > 0) {
        this.#removeUids(fresh, [...vanished], ctx);
        this.#vanished.delete(fresh.path);
      }
      const passes = (state.passes ?? 0) + 1;
      const knownCount = this.#deps.syncStore.uidMap(fresh.id).size;
      const shrank = state.lastExists !== undefined && info.exists < state.lastExists;
      if (this.#uidCheck.has(fresh.path) || shrank || info.exists < knownCount || passes % UID_CHECK_EVERY === 0) {
        this.#uidCheck.delete(fresh.path);
        await this.#compareUids(client, fresh, ctx);
      }

      const next = Math.max(info.uidNext, lastNext);
      this.#deps.store.mailboxes.update(fresh.id, {
        uidvalidity: uidValidity,
        uidnext: next,
        highestmodseq: highest !== null ? String(highest) : fresh.highestmodseq,
        sync: { ...state, lastExists: info.exists, passes } as Record<string, unknown>,
      });
    } finally {
      lock.release();
    }
    if (resync) await this.#syncMailbox(client, mailbox, ctx);
  }

  /**
   * Compares the uids we know with the server's: gone ones are removed; ones we don't know inside
   * the synced range (a change that didn't reach the server and was undone there, a copy made by
   * another client) are fetched, so the two sides can't drift apart for good.
   */
  async #compareUids(client: ImapFlow, mailbox: MailboxRecord, ctx: PassContext): Promise<void> {
    const known = this.#deps.syncStore.uidMap(mailbox.id);
    const state = (mailbox.sync ?? {}) as MailboxSyncState;
    const lowest = state.backfillCursor ?? minOf(known.keys());
    if (lowest === null || lowest === undefined) return;
    const found = await client.search({ uid: `${lowest}:*` }, { uid: true });
    if (!Array.isArray(found)) return;
    const present = new Set(found);
    const missing = [...known.keys()].filter((u) => u >= lowest && !present.has(u));
    if (missing.length > 0) this.#removeUids(mailbox, missing, ctx);
    const next = mailbox.uidnext ?? Number.MAX_SAFE_INTEGER;
    const unknown = found.filter((u) => !known.has(u) && u < next).sort((a, b) => b - a);
    if (unknown.length > 0) {
      this.#log.info("found messages the app didn't know about; fetching them", { path: mailbox.path, count: unknown.length });
      const repair = { ...ctx, initial: true };
      for (let i = 0; i < unknown.length; i += BATCH) await this.#fetchHeadersLocked(client, mailbox, unknown.slice(i, i + BATCH), repair);
    }
  }

  /** Messages gone from a mailbox on the server. Orphans are deleted at the end of the pass. */
  #removeUids(mailbox: MailboxRecord, uids: number[], ctx: PassContext): void {
    const map = this.#deps.syncStore.uidMap(mailbox.id);
    const virtual = this.#gmail && mailbox.role === "all" ? this.#virtualMailboxes() : [];
    this.#deps.db.tx(() => {
      for (const uid of uids) {
        const messageId = map.get(uid);
        if (!messageId || ctx.protected.has(messageId)) continue;
        const m = this.#deps.store.messages.get(messageId);
        if (!m) continue;
        this.#deps.store.messages.removeLocation(messageId, mailbox.id);
        // Gmail: Inbox, Sent, … memberships come from All Mail; gone from it, gone from them.
        for (const v of virtual) this.#deps.store.messages.removeLocation(messageId, v.id);
        ctx.touched.add(m.threadId);
      }
    });
  }

  #virtualMailboxes(): MailboxRecord[] {
    return this.#deps.store.mailboxes.list(this.accountId).filter((m) => m.role !== null && GMAIL_VIRTUAL_ROLES.includes(m.role));
  }

  /** Deletes local messages that are nowhere on the server any more (moved or deleted elsewhere). */
  #cleanupOrphans(): void {
    const orphans = this.#deps.syncStore.orphans(this.accountId);
    if (orphans.length === 0) return;
    const pending = this.#deps.syncStore.pendingMessageIds(this.accountId);
    const doomed = orphans.filter((o) => !pending.has(o.id));
    if (doomed.length === 0) return;
    const files = this.#deps.store.messages.attachments(doomed.map((o) => o.id)).flatMap((a) => (a.localPath ? [a.localPath] : []));
    this.#deps.db.tx(() => {
      this.#deps.store.messages.delete(doomed.map((o) => o.id));
      this.#deps.store.refreshThreads(doomed.map((o) => o.threadId));
    });
    for (const f of files) {
      try {
        if (f.startsWith(this.#deps.config.dataDir)) fs.rmSync(f, { force: true });
      } catch {
        // a file we can't delete is harmless
      }
    }
    this.#index = null;
    this.#deps.bus.publish({ type: "invalidate", topics: ["threads", "mailboxes", "accounts", "labels"] });
  }

  // ── Storing headers ───────────────────────────────────────────────────────────────────────

  async #fetchAndStore(client: ImapFlow, mailbox: MailboxRecord, uids: number[], ctx: PassContext): Promise<void> {
    if (uids.length === 0) return;
    const lock = await client.getMailboxLock(mailbox.path);
    try {
      await this.#fetchHeadersLocked(client, mailbox, uids, ctx);
    } finally {
      lock.release();
    }
  }

  async #fetchHeadersLocked(client: ImapFlow, mailbox: MailboxRecord, uids: number[], ctx: PassContext): Promise<void> {
    if (uids.length === 0) return;
    const messages = await client.fetchAll(uids, this.#headerQuery(), { uid: true });
    // Newest first, like the uids: the thread index learns replies before what they answer.
    messages.sort((a, b) => b.uid - a.uid);
    this.#storeHeaders(mailbox, messages, ctx);
  }

  #threadIndex(account: AccountRecord): ThreadIndex {
    if (this.#index) return this.#index;
    const index = new ThreadIndex([account.email]);
    for (const row of this.#deps.syncStore.threadIndexRows(this.accountId)) {
      index.add(
        {
          messageIdHeader: row.message_id_header,
          inReplyTo: row.in_reply_to,
          references: JSON.parse(row.references_json || "[]") as string[],
          subject: row.subject,
          date: row.date,
          from: row.from_json ? JSON.parse(row.from_json) : null,
          to: JSON.parse(row.to_json || "[]"),
          cc: JSON.parse(row.cc_json || "[]"),
        },
        row.thread_id,
      );
    }
    this.#index = index;
    return index;
  }

  #labelIdsFor(names: string[], ctx: PassContext): string[] {
    const ids: string[] = [];
    for (const name of names) {
      const { label, created } = this.#deps.syncStore.labelByName(name, Date.now());
      if (created) ctx.labelsChanged = true;
      ids.push(label.id);
    }
    return ids;
  }

  /** Sets a message's labels to exactly these (the server's view). */
  #setLabels(messageId: string, labelIds: string[], ctx: PassContext): boolean {
    const current = this.#deps.syncStore.labelIdsOf([messageId]).get(messageId) ?? new Set<string>();
    const wanted = new Set(labelIds);
    let changed = false;
    for (const id of current) {
      if (!wanted.has(id)) {
        this.#deps.store.messages.removeLabel(messageId, id);
        changed = true;
      }
    }
    for (const id of wanted) {
      if (!current.has(id)) {
        this.#deps.store.messages.addLabel(messageId, id);
        changed = true;
      }
    }
    if (changed) ctx.labelsChanged = true;
    return changed;
  }

  /** Gmail: Inbox/Sent/… locations of a message in All Mail, from its labels. Returns whether anything changed. */
  #setVirtualLocations(messageId: string, roles: Set<MailboxRole>, inAllMail: boolean): boolean {
    const have = new Set(this.#deps.store.messages.locations([messageId]).map((l) => l.mailboxId));
    let changed = false;
    for (const v of this.#virtualMailboxes()) {
      const want = inAllMail && roles.has(v.role!);
      if (want && !have.has(v.id)) {
        this.#deps.store.messages.addLocation(messageId, v.id, null);
        changed = true;
      } else if (!want && have.has(v.id)) {
        this.#deps.store.messages.removeLocation(messageId, v.id);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Plain IMAP: a message in two folders (sent to yourself: INBOX and Sent) takes its flags from
   * one copy only, so the copies don't overwrite each other every pass. Inbox first, Sent last.
   */
  #isPrimaryCopy(messageId: string, mailboxId: string): boolean {
    if (this.#gmail) return true;
    const rank = (role: MailboxRole | null) => (role === "inbox" ? 0 : role === "sent" ? 2 : role === "trash" || role === "spam" ? 3 : 1);
    const locations = this.#deps.store.messages.locations([messageId]).filter((l) => l.uid !== null || l.mailboxId === mailboxId);
    if (locations.length <= 1) return true;
    const best = locations.sort((a, b) => rank(a.role) - rank(b.role) || a.path.localeCompare(b.path))[0]!;
    return best.mailboxId === mailboxId;
  }

  #storeHeaders(mailbox: MailboxRecord, messages: FetchMessageObject[], ctx: PassContext): void {
    const { store, syncStore, db } = this.#deps;
    const account = store.accounts.get(this.accountId);
    if (!account || messages.length === 0) return;
    const protectedNow = syncStore.pendingMessageIds(this.accountId);
    for (const id of protectedNow) ctx.protected.add(id);
    const gmail = this.#gmail;
    const allBox = gmail ? store.mailboxes.byRole(this.accountId, "all") : null;
    const keywords = this.#keywordsOk.get(mailbox.path) ?? true;
    const now = Date.now();

    db.tx(() => {
      for (const msg of messages) {
        const info = headerInfo(msg, gmail, now);
        let existing = store.messages.byRemoteId(this.accountId, info.remoteId);
        if (!existing && gmail && info.messageIdHeader) {
          // Our own sent message, now seen on the server: adopt it.
          const local = syncStore.localByMessageId(this.accountId, info.messageIdHeader);
          if (local) {
            store.messages.update(local, { remoteId: info.remoteId, gmThreadId: info.gmThreadId });
            existing = store.messages.get(local);
          }
        }
        if (existing) this.#updateExisting(existing, info, mailbox, allBox, keywords, ctx);
        else this.#insertNew(account, info, mailbox, keywords, ctx);
      }
      store.refreshThreads(ctx.touched);
    });
  }

  #updateExisting(existing: MessageRecord, info: HeaderInfo, mailbox: MailboxRecord, allBox: MailboxRecord | null, keywords: boolean, ctx: PassContext): void {
    const { store } = this.#deps;
    ctx.touched.add(existing.threadId);
    if (ctx.protected.has(existing.id)) {
      // A local change is on its way: learn the uid where we expect the message, add nothing.
      if (store.messages.locations([existing.id]).some((l) => l.mailboxId === mailbox.id)) {
        store.messages.setLocationUid(existing.id, mailbox.id, info.uid);
      }
      return;
    }
    store.messages.addLocation(existing.id, mailbox.id, info.uid);
    const patch: Partial<MessageRecord> = {};
    if (this.#isPrimaryCopy(existing.id, mailbox.id)) {
      if (existing.unread !== info.unread) patch.unread = info.unread;
      if (existing.starred !== info.starred) patch.starred = info.starred;
      if (existing.isDraft !== info.isDraft) patch.isDraft = info.isDraft;
    }
    if (this.#gmail && info.gmThreadId && !existing.gmThreadId) patch.gmThreadId = info.gmThreadId;
    if (Object.keys(patch).length > 0) store.messages.update(existing.id, patch);
    if (this.#gmail) {
      const { roles, names } = splitGmailLabels(info.gmailLabels);
      this.#setLabels(existing.id, this.#labelIdsFor(names, ctx), ctx);
      if (mailbox.role === "all") {
        this.#setVirtualLocations(existing.id, roles, true);
        this.#removeRoleLocations(existing.id, ["trash", "spam"]);
      } else if (mailbox.role === "trash" || mailbox.role === "spam") {
        this.#setVirtualLocations(existing.id, roles, false);
        if (allBox) store.messages.removeLocation(existing.id, allBox.id);
        this.#removeRoleLocations(existing.id, [mailbox.role === "trash" ? "spam" : "trash"]);
      }
    } else if (keywords && this.#isPrimaryCopy(existing.id, mailbox.id)) {
      this.#setLabels(existing.id, this.#labelIdsFor(labelsFromFlags(info.flags), ctx), ctx);
    }
  }

  #removeRoleLocations(messageId: string, roles: MailboxRole[]): void {
    for (const role of roles) {
      const box = this.#deps.store.mailboxes.byRole(this.accountId, role);
      if (box) this.#deps.store.messages.removeLocation(messageId, box.id);
    }
  }

  #insertNew(account: AccountRecord, info: HeaderInfo, mailbox: MailboxRecord, keywords: boolean, ctx: PassContext): void {
    const { store, syncStore } = this.#deps;
    let threadId: string;
    const candidate: ThreadCandidate = {
      messageIdHeader: info.messageIdHeader,
      inReplyTo: info.inReplyTo,
      references: info.references,
      subject: info.subject,
      date: info.date,
      from: info.from,
      to: info.to,
      cc: info.cc,
    };
    if (this.#gmail && info.gmThreadId) {
      threadId = this.#gmThreads.get(info.gmThreadId) ?? syncStore.threadForGmailThread(this.accountId, info.gmThreadId) ?? newId("thr");
      this.#gmThreads.set(info.gmThreadId, threadId);
    } else {
      const index = this.#threadIndex(account);
      const resolved = index.resolve(candidate, () => newId("thr"));
      threadId = resolved.threadId;
      if (resolved.merge.length > 0) {
        syncStore.mergeThreads(this.accountId, resolved.merge, threadId);
        for (const old of resolved.merge) {
          index.rename(old, threadId);
          ctx.touched.add(old);
        }
      }
      index.add(candidate, threadId);
    }

    const id = newId("msg");
    const files = info.attachments.filter((a) => !a.inline);
    store.messages.insert({
      id,
      accountId: this.accountId,
      threadId,
      remoteId: info.remoteId,
      gmThreadId: info.gmThreadId,
      messageIdHeader: info.messageIdHeader,
      inReplyTo: info.inReplyTo,
      references: info.references,
      subject: info.subject,
      from: info.from,
      to: info.to,
      cc: info.cc,
      bcc: info.bcc,
      replyTo: info.replyTo,
      date: info.date,
      snippet: "",
      size: info.size,
      unread: info.unread,
      starred: info.starred,
      isDraft: info.isDraft,
      hasAttachments: files.length > 0,
      bodyState: "none",
    });
    store.messages.addLocation(id, mailbox.id, info.uid);
    let inInbox = mailbox.role === "inbox";
    if (this.#gmail) {
      const { roles, names } = splitGmailLabels(info.gmailLabels);
      if (mailbox.role === "all") this.#setVirtualLocations(id, roles, true);
      inInbox = mailbox.role === "all" && roles.has("inbox");
      for (const labelId of this.#labelIdsFor(names, ctx)) store.messages.addLabel(id, labelId);
      if (names.length > 0) ctx.labelsChanged = true;
    } else if (keywords) {
      const names = labelsFromFlags(info.flags);
      for (const labelId of this.#labelIdsFor(names, ctx)) store.messages.addLabel(id, labelId);
      if (names.length > 0) ctx.labelsChanged = true;
    }
    info.attachments.forEach((a, index) => {
      store.messages.insertAttachment({
        id: newId("att"),
        messageId: id,
        part: a.part,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        contentId: a.contentId,
        inline: a.inline,
        localPath: null,
        sortOrder: index,
      });
    });
    ctx.touched.add(threadId);
    ctx.newMessages.push(id);
    this.#log.debug("new message", { path: mailbox.path, uid: info.uid, initial: ctx.initial, inInbox, unread: info.unread });
    if (!ctx.initial && inInbox && info.unread && !info.isDraft) ctx.newInbox.add(id);
  }

  /** Flags and labels that changed on the server (CHANGEDSINCE or the newest-uids check). */
  #applyChanges(mailbox: MailboxRecord, changed: FetchMessageObject[], ctx: PassContext): void {
    if (changed.length === 0) return;
    const { store, syncStore, db } = this.#deps;
    const map = syncStore.uidMap(mailbox.id);
    for (const id of syncStore.pendingMessageIds(this.accountId)) ctx.protected.add(id);
    const keywords = this.#keywordsOk.get(mailbox.path) ?? true;
    db.tx(() => {
      for (const msg of changed) {
        const messageId = map.get(msg.uid);
        if (!messageId || ctx.protected.has(messageId)) continue;
        const m = store.messages.get(messageId);
        if (!m) continue;
        if (!this.#isPrimaryCopy(messageId, mailbox.id)) continue;
        const flags = msg.flags ?? new Set<string>();
        const unread = !flags.has("\\Seen");
        const starred = flags.has("\\Flagged");
        const isDraft = flags.has("\\Draft");
        let changedAny = false;
        if (msg.flags) {
          const patch: Partial<MessageRecord> = {};
          if (m.unread !== unread) patch.unread = unread;
          if (m.starred !== starred) patch.starred = starred;
          if (!this.#gmail && m.isDraft !== isDraft) patch.isDraft = isDraft;
          if (Object.keys(patch).length > 0) {
            store.messages.update(messageId, patch);
            changedAny = true;
          }
        }
        if (this.#gmail && msg.labels) {
          const { roles, names } = splitGmailLabels(msg.labels);
          if (this.#setLabels(messageId, this.#labelIdsFor(names, ctx), ctx)) changedAny = true;
          if (mailbox.role === "all" && this.#setVirtualLocations(messageId, roles, true)) changedAny = true;
        } else if (!this.#gmail && keywords && msg.flags) {
          if (this.#setLabels(messageId, this.#labelIdsFor(labelsFromFlags(flags), ctx), ctx)) changedAny = true;
        }
        if (changedAny) ctx.touched.add(m.threadId);
      }
      store.refreshThreads(ctx.touched);
    });
  }

  #flush(ctx: PassContext): void {
    if (ctx.touched.size === 0 && !ctx.labelsChanged) return;
    const topics: ("threads" | "mailboxes" | "accounts" | "groups" | "labels")[] = ["threads", "mailboxes", "accounts", "groups"];
    if (ctx.labelsChanged) topics.push("labels");
    ctx.touched.clear();
    ctx.labelsChanged = false;
    this.#deps.bus.publish({ type: "invalidate", topics });
  }

  #saveSyncInfo(patch: AccountSyncInfo): void {
    const current = (this.#deps.store.accounts.getSyncState(this.accountId) ?? {}) as AccountSyncInfo;
    this.#deps.store.accounts.setSyncState(this.accountId, { ...current, ...patch } as Record<string, unknown>);
  }

  // ── Bodies and attachments ────────────────────────────────────────────────────────────────

  #queuePrefetch(newest?: string[]): void {
    const count = this.#deps.settings().sync.bodyPrefetchCount;
    if (count <= 0) return;
    const ids = newest ?? this.#deps.syncStore.newestWithoutBody(this.accountId, count);
    const queued = new Set(this.#prefetch);
    for (const id of ids) if (!queued.has(id)) this.#prefetch.push(id);
    if (this.#prefetch.length > count * 2) this.#prefetch = this.#prefetch.slice(0, count * 2);
    this.#work.notify();
  }

  async #runUrgentBodies(client: ImapFlow): Promise<void> {
    const ids = [...this.#urgentBodies.entries()].sort((a, b) => b[1] - a[1]).slice(0, BODY_BATCH * 2).map(([id]) => id);
    for (const id of ids) this.#urgentBodies.delete(id);
    await this.#fetchBodies(client, ids, true);
  }

  async #runPrefetch(client: ImapFlow): Promise<void> {
    const ids = this.#prefetch.splice(0, BODY_BATCH);
    const messages = this.#deps.store.messages.byIds(ids).filter((m) => m.bodyState === "none" && m.size <= PREFETCH_MAX_BYTES);
    await this.#fetchBodies(client, messages.map((m) => m.id), false);
  }

  /** Where to fetch a message's source from: a location with a uid (Gmail: All Mail, Trash, Spam). */
  #sourceLocation(messageId: string): { path: string; mailboxId: string; uid: number } | null {
    const locations = this.#deps.store.messages.locations([messageId]).filter((l) => l.uid !== null);
    const order = (role: MailboxRole | null) => (role === "all" ? 0 : role === "inbox" ? 1 : role === "trash" || role === "spam" ? 3 : 2);
    const best = locations.sort((a, b) => order(a.role) - order(b.role))[0];
    return best ? { path: best.path, mailboxId: best.mailboxId, uid: best.uid! } : null;
  }

  async #fetchBodies(client: ImapFlow, ids: string[], urgent: boolean, force = false): Promise<void> {
    const { store } = this.#deps;
    const messages = store.messages.byIds(ids).filter((m) => force || m.bodyState !== "ready");
    if (messages.length === 0) return;
    const byPath = new Map<string, { message: MessageRecord; uid: number }[]>();
    for (const m of messages) {
      let loc = this.#sourceLocation(m.id);
      if (!loc) {
        const found = await this.#findOnServer(client, m);
        if (found) {
          loc = { path: found.path, mailboxId: found.mailboxId ?? "", uid: found.uid };
          if (found.mailboxId && store.messages.locations([m.id]).some((l) => l.mailboxId === found.mailboxId)) {
            store.messages.setLocationUid(m.id, found.mailboxId, found.uid);
          }
        }
      }
      if (!loc) {
        this.#bodyFailed(m, "The message isn't on the server any more.");
        continue;
      }
      const list = byPath.get(loc.path) ?? [];
      list.push({ message: m, uid: loc.uid });
      byPath.set(loc.path, list);
    }
    const threads = new Set<string>();
    for (const [path, items] of byPath) {
      for (let i = 0; i < items.length; i += BODY_BATCH) {
        const slice = items.slice(i, i + BODY_BATCH);
        const lock = await client.getMailboxLock(path);
        let fetched: FetchMessageObject[] = [];
        try {
          fetched = await client.fetchAll(slice.map((s) => s.uid), { uid: true, source: true }, { uid: true });
        } finally {
          lock.release();
        }
        const byUid = new Map(fetched.map((f) => [f.uid, f]));
        for (const item of slice) {
          const got = byUid.get(item.uid);
          if (!got?.source) {
            this.#bodyFailed(item.message, "The server didn't return the message.");
            threads.add(item.message.threadId);
            continue;
          }
          try {
            const parsed = await parseSource(got.source);
            const current = store.messages.get(item.message.id);
            if (!current) continue;
            storeParsedBody(store, this.#deps.config.dataDir, current, parsed, Date.now());
            threads.add(current.threadId);
          } catch (error) {
            this.#log.warn("could not read a message", { messageId: item.message.id, error: (error as Error).message });
            this.#bodyFailed(item.message, "Fancy Mail couldn't read this message.");
            threads.add(item.message.threadId);
          }
        }
        if (urgent && threads.size > 0) {
          this.#deps.bus.publish({ type: "invalidate", topics: ["threads"], threadIds: [...threads] });
          threads.clear();
        }
      }
    }
    if (threads.size > 0) this.#deps.bus.publish({ type: "invalidate", topics: ["threads"], threadIds: [...threads] });
  }

  #bodyFailed(m: MessageRecord, reason: string): void {
    const attempts = m.bodyAttempts + 1;
    if (attempts >= MAX_BODY_TRIES) {
      this.#deps.store.messages.update(m.id, { bodyAttempts: attempts, bodyState: "failed", bodyError: reason });
      this.#deps.bus.publish({ type: "invalidate", topics: ["threads"], threadIds: [m.threadId] });
    } else {
      this.#deps.store.messages.update(m.id, { bodyAttempts: attempts });
    }
  }

  async #runAttachments(client: ImapFlow): Promise<void> {
    const entries = [...this.#attachments.entries()];
    this.#attachments.clear();
    for (const [attachmentId, waiters] of entries) {
      const finish = (error: Error | null, file?: string) => {
        for (const w of waiters) (error ? w.reject(error) : w.resolve(file!));
      };
      try {
        const att = this.#deps.store.messages.attachment(attachmentId);
        if (!att) throw new AppError("not_found", "This attachment's message was deleted.");
        if (att.localPath && fs.existsSync(att.localPath)) {
          finish(null, att.localPath);
          continue;
        }
        const message = this.#deps.store.messages.get(att.messageId);
        if (!message) throw new AppError("not_found", "This attachment's message was deleted.");
        // The body download writes every file of the message.
        await this.#fetchBodies(client, [message.id], true, true);
        const after = this.#deps.store.messages.attachment(attachmentId);
        if (after?.localPath && fs.existsSync(after.localPath)) finish(null, after.localPath);
        else throw new AppError("not_found", "This attachment couldn't be found in the message on the server.");
      } catch (error) {
        if (!client.usable || isNetworkError(error)) {
          finish(new AppError("connection_failed", "The connection to the mail server dropped. Try again in a moment."));
          throw new ConnectionLost(error);
        }
        finish(error instanceof AppError ? error : new AppError("internal", "The attachment couldn't be downloaded. Try again."));
      }
    }
  }

  // ── Finding messages on the server ────────────────────────────────────────────────────────

  /** Searches a message by X-GM-MSGID (Gmail) or Message-ID in the mailboxes it may be in. */
  async #findOnServer(client: ImapFlow, m: Pick<MessageRecord, "id" | "remoteId" | "messageIdHeader">, paths?: string[]): Promise<ServerCopy | null> {
    const boxes = this.#syncedMailboxes();
    const candidates = paths ? boxes.filter((b) => paths.includes(b.path)) : boxes;
    for (const box of candidates) {
      const query = this.#gmail && m.remoteId && /^\d+$/.test(m.remoteId) ? { emailId: m.remoteId } : m.messageIdHeader ? { header: { "message-id": m.messageIdHeader } } : null;
      if (!query) return null;
      const lock = await client.getMailboxLock(box.path);
      try {
        const found = await client.search(query, { uid: true });
        if (Array.isArray(found) && found.length > 0) {
          const uid = maxOf(found)!;
          return { path: box.path, mailboxId: box.id, role: box.role, uid };
        }
      } finally {
        lock.release();
      }
    }
    return null;
  }

  /** Which of these uids still exist in the mailbox. */
  async #existing(client: ImapFlow, path: string, uids: number[]): Promise<Set<number>> {
    if (uids.length === 0) return new Set();
    const lock = await client.getMailboxLock(path);
    try {
      const found = await client.search({ uid: [...new Set(uids)].join(",") }, { uid: true });
      return new Set(Array.isArray(found) ? found : []);
    } finally {
      lock.release();
    }
  }

  // ── Outbox ────────────────────────────────────────────────────────────────────────────────

  async #drainOutbox(client: ImapFlow): Promise<void> {
    this.#wantOutbox = false;
    const { store } = this.#deps;
    const ops = store.outbox.pending(this.accountId);
    if (ops.length === 0) return;
    const blocked = new Set<string>();
    let failedNow = 0;
    let changedUi = false;
    for (const op of ops) {
      if (this.#stopped || !client.usable) throw new ConnectionLost();
      const ids = op.kind === "modify" ? (op.payload as Extract<OutboxPayload, { kind: "modify" }>).changes.map((c) => c.message.id) : [];
      if (op.nextAttemptAt > Date.now()) {
        for (const id of ids) blocked.add(id);
        continue;
      }
      if (ids.some((id) => blocked.has(id))) continue;
      try {
        changedUi = (await this.#runOp(client, op)) || changedUi;
        store.outbox.complete(op.id);
      } catch (error) {
        if (!client.usable || isNetworkError(error) || error instanceof ConnectionLost) throw new ConnectionLost(error);
        const attempts = op.attempts + 1;
        const account = store.accounts.get(this.accountId);
        const message = classifyError(error, { host: account?.imap?.host ?? "the server", provider: account?.provider ?? "imap", mode: "background", protocol: "imap" }).message;
        this.#log.warn("a change couldn't be saved on the server", { kind: op.kind, attempts, error: (error as Error).message });
        if (attempts >= MAX_OP_ATTEMPTS) {
          store.outbox.fail(op.id, message);
          failedNow++;
        } else {
          store.outbox.retryLater(op.id, message, Date.now() + retryDelayMs(attempts));
          for (const id of ids) blocked.add(id);
          this.#scheduleRetry(retryDelayMs(attempts));
        }
      }
    }
    if (failedNow > 0) this.#setReady();
    if (changedUi) this.#deps.bus.publish({ type: "invalidate", topics: ["mailboxes"] });
  }

  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  #scheduleRetry(ms: number): void {
    if (this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.notifyOutbox();
    }, ms + 500);
    this.#retryTimer.unref?.();
  }

  /** Runs one op. Returns true when mailbox rows changed. */
  async #runOp(client: ImapFlow, op: OutboxRecord): Promise<boolean> {
    const payload = op.payload as OutboxPayload | null;
    if (!payload) return false;
    switch (payload.kind) {
      case "modify":
        await this.#runModify(client, payload.changes);
        return false;
      case "createMailbox":
        return this.#ensureMailbox(client, payload.mailbox.id);
      case "labelRename":
        await this.#renameLabel(client, payload.from, payload.to);
        return false;
      case "labelDelete":
        await this.#deleteLabel(client, payload.name);
        return false;
      case "deleteDraft": {
        if (payload.remoteUid === null || !payload.mailboxId) return false;
        const box = this.#deps.store.mailboxes.get(payload.mailboxId);
        if (!box) return false;
        const lock = await client.getMailboxLock(box.path);
        try {
          await client.messageDelete(String(payload.remoteUid), { uid: true });
        } finally {
          lock.release();
        }
        return false;
      }
      default:
        this.#log.warn("unknown outbox op, dropped", { kind: (payload as { kind: string }).kind });
        return false;
    }
  }

  /** Makes sure a mailbox the app created locally exists on the server. */
  async #ensureMailbox(client: ImapFlow, mailboxId: string): Promise<boolean> {
    const box = this.#deps.store.mailboxes.get(mailboxId);
    if (!box) return false;
    if (this.#serverPaths.has(box.path)) {
      if (box.createdLocally) this.#deps.store.mailboxes.update(box.id, { createdLocally: false });
      return true;
    }
    let path = box.path;
    const prefix = client.namespace?.prefix ?? "";
    if (prefix && !path.startsWith(prefix) && path.toUpperCase() !== "INBOX") path = `${prefix}${path}`;
    const created = await client.mailboxCreate(path);
    path = created.path || path;
    await client.mailboxSubscribe(path).catch(() => undefined);
    this.#serverPaths.add(path);
    this.#deps.store.mailboxes.update(box.id, { path, createdLocally: false, delimiter: client.namespace?.delimiter ?? box.delimiter });
    this.#log.info("created a folder on the server", { path });
    return true;
  }

  async #ensureMailboxPath(client: ImapFlow, path: string): Promise<void> {
    if (this.#serverPaths.has(path)) return;
    const box = this.#deps.store.mailboxes.byPath(this.accountId, path);
    if (box) {
      await this.#ensureMailbox(client, box.id);
      return;
    }
    await client.mailboxCreate(path);
    this.#serverPaths.add(path);
  }

  /** Gmail labels must exist before X-GM-LABELS can add them. */
  async #ensureGmailLabels(client: ImapFlow, names: string[]): Promise<void> {
    const lowerPaths = new Set([...this.#serverPaths].map((p) => p.toLowerCase()));
    for (const name of names) {
      if (name.startsWith("\\") || lowerPaths.has(name.toLowerCase())) continue;
      try {
        await client.mailboxCreate(name);
      } catch (error) {
        // "already exists" is fine (another client made it meanwhile).
        if (!/exist/i.test(String((error as { responseText?: string }).responseText ?? (error as Error).message))) throw error;
      }
      this.#serverPaths.add(name);
      lowerPaths.add(name.toLowerCase());
    }
  }

  /** The verified server copies of a change's message, before the change. */
  async #resolveCopies(client: ImapFlow, changes: OutboxMessageChange[]): Promise<Map<string, ServerCopy[]>> {
    const { store } = this.#deps;
    const pathOf = (id: string, fallback: string) => store.mailboxes.get(id)?.path ?? fallback;
    // Candidates: current locations with a uid, where it left (uid at the time), our own moves.
    const candidates = new Map<string, ServerCopy[]>();
    const locations = store.messages.locations(changes.map((c) => c.message.id));
    for (const change of changes) {
      const list: ServerCopy[] = [];
      const add = (c: ServerCopy) => {
        if (!list.some((x) => x.path === c.path && x.uid === c.uid)) list.push(c);
      };
      for (const l of locations) {
        if (l.messageId === change.message.id && l.uid !== null) add({ path: l.path, mailboxId: l.mailboxId, role: l.role, uid: l.uid });
      }
      for (const r of change.removeFrom) {
        if (r.uid !== null) add({ path: pathOf(r.id, r.path), mailboxId: r.id, role: r.role, uid: r.uid });
      }
      for (const [path, uid] of this.#movedTo.get(change.message.id) ?? []) {
        const box = store.mailboxes.byPath(this.accountId, path);
        add({ path, mailboxId: box?.id ?? null, role: box?.role ?? null, uid });
      }
      candidates.set(change.message.id, list);
    }
    // Verify per mailbox in one search each.
    const byPath = new Map<string, number[]>();
    for (const list of candidates.values()) for (const c of list) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c.uid]);
    const present = new Map<string, Set<number>>();
    for (const [path, uids] of byPath) {
      try {
        present.set(path, await this.#existing(client, path, uids));
      } catch (error) {
        if (!client.usable) throw error;
        present.set(path, new Set());
      }
    }
    const out = new Map<string, ServerCopy[]>();
    for (const change of changes) {
      const verified = (candidates.get(change.message.id) ?? []).filter((c) => present.get(c.path)?.has(c.uid));
      // One copy per folder.
      const perPath = new Map<string, ServerCopy>();
      for (const c of verified) if (!perPath.has(c.path) || perPath.get(c.path)!.uid < c.uid) perPath.set(c.path, c);
      let copies = [...perPath.values()];
      if (copies.length === 0) {
        const where = this.#gmail ? undefined : [...new Set([...change.removeFrom.map((r) => pathOf(r.id, r.path)), ...locations.filter((l) => l.messageId === change.message.id).map((l) => l.path)])];
        const found = await this.#findOnServer(client, change.message, where && where.length > 0 ? where : undefined);
        if (found) copies = [found];
      }
      out.set(change.message.id, copies);
    }
    return out;
  }

  async #runModify(client: ImapFlow, changes: OutboxMessageChange[]): Promise<void> {
    const { store } = this.#deps;
    // Paths may have changed since the op was written (a local "Archive" created as "INBOX.Archive").
    const current = (ref: { id: string; path: string }) => store.mailboxes.get(ref.id)?.path ?? ref.path;
    const fixed = changes.map((c) => ({
      ...c,
      addTo: c.addTo.map((t) => ({ ...t, path: current(t) })),
      removeFrom: c.removeFrom.map((r) => ({ ...r, path: current(r) })),
    }));
    const copies = await this.#resolveCopies(client, fixed);
    const commands: ImapCommand[] = [];
    if (this.#gmail) {
      const paths = {
        inbox: store.mailboxes.byRole(this.accountId, "inbox")?.path ?? "INBOX",
        all: store.mailboxes.byRole(this.accountId, "all")?.path ?? "[Gmail]/All Mail",
        trash: store.mailboxes.byRole(this.accountId, "trash")?.path ?? "[Gmail]/Trash",
        spam: store.mailboxes.byRole(this.accountId, "spam")?.path ?? "[Gmail]/Spam",
      };
      const labels = new Set<string>();
      for (const change of fixed) {
        const list = copies.get(change.message.id) ?? [];
        const copy = list.find((c) => c.role === "all") ?? list.find((c) => c.role === "trash" || c.role === "spam") ?? list[0] ?? null;
        if (!copy) this.#log.info("message not on the server any more; change skipped", { messageId: change.message.id });
        for (const name of change.addLabels) labels.add(name);
        commands.push(...planGmailChange(change, copy, paths));
      }
      if (labels.size > 0) await this.#ensureGmailLabels(client, [...labels]);
    } else {
      for (const change of fixed) {
        const list = copies.get(change.message.id) ?? [];
        if (list.length === 0) this.#log.info("message not on the server any more; change skipped", { messageId: change.message.id });
        const keywords = list.every((c) => this.#keywordsOk.get(c.path) ?? true);
        commands.push(...planImapChange(change, list, { keywords }));
      }
    }
    await this.#execute(client, commands);
  }

  async #execute(client: ImapFlow, commands: ImapCommand[]): Promise<void> {
    const { store } = this.#deps;
    for (const group of groupCommands(commands)) {
      const first = group.first;
      const uids = [...new Set(group.items.map((c) => c.uid))];
      if (first.type === "flags") {
        const lock = await client.getMailboxLock(first.path);
        try {
          const opts = { uid: true, useLabels: first.useLabels };
          if (first.add.length > 0) await client.messageFlagsAdd(uids, first.add, opts);
          if (first.remove.length > 0) await client.messageFlagsRemove(uids, first.remove, opts);
        } finally {
          lock.release();
        }
        continue;
      }
      await this.#ensureMailboxPath(client, first.to);
      const run = async () => {
        const lock = await client.getMailboxLock(first.path);
        try {
          return first.type === "move" ? await client.messageMove(uids, first.to, { uid: true }) : await client.messageCopy(uids, first.to, { uid: true });
        } finally {
          lock.release();
        }
      };
      let result;
      try {
        result = await run();
      } catch (error) {
        const e = error as { serverResponseCode?: string; mailboxMissing?: boolean; responseText?: string };
        if (e.serverResponseCode === "TRYCREATE" || e.mailboxMissing || /TRYCREATE|doesn't exist|does not exist|not found/i.test(e.responseText ?? "")) {
          await client.mailboxCreate(first.to);
          this.#serverPaths.add(first.to);
          result = await run();
        } else {
          throw error;
        }
      }
      if (result === false) throw Object.assign(new Error(`${first.type} failed`), { responseText: `Couldn't ${first.type} messages to ${first.to}` });
      const map = result?.uidMap;
      for (const item of group.items) {
        if (item.type === "flags") continue;
        const newUid = map?.get(item.uid);
        if (newUid === undefined) continue;
        let moved = this.#movedTo.get(item.messageId);
        if (!moved) this.#movedTo.set(item.messageId, (moved = new Map()));
        moved.set(item.to, newUid);
        if (item.type === "move") moved.delete(item.path);
        const box = item.toMailboxId ? store.mailboxes.get(item.toMailboxId) : store.mailboxes.byPath(this.accountId, item.to);
        // Gmail's Inbox/Sent/… rows are labels (uid NULL); only real folders keep uids.
        const real = !this.#gmail || box?.role === "all" || box?.role === "trash" || box?.role === "spam";
        if (box && real) {
          const has = store.messages.locations([item.messageId]).some((l) => l.mailboxId === box.id);
          if (has) store.messages.setLocationUid(item.messageId, box.id, newUid);
        }
      }
    }
  }

  async #renameLabel(client: ImapFlow, from: string, to: string): Promise<void> {
    if (this.#gmail) {
      const existing = [...this.#serverPaths].find((p) => p.toLowerCase() === from.toLowerCase());
      if (!existing) return;
      if ([...this.#serverPaths].some((p) => p.toLowerCase() === to.toLowerCase())) return;
      await client.mailboxRename(existing, to);
      this.#serverPaths.delete(existing);
      this.#serverPaths.add(to);
      return;
    }
    const oldKw = labelToKeyword(from);
    const newKw = labelToKeyword(to);
    if (oldKw === newKw) return;
    for (const box of this.#syncedMailboxes()) {
      if (!(this.#keywordsOk.get(box.path) ?? true)) continue;
      const lock = await client.getMailboxLock(box.path);
      try {
        const found = await client.search({ keyword: oldKw }, { uid: true });
        if (Array.isArray(found) && found.length > 0) {
          await client.messageFlagsAdd(found, [newKw], { uid: true });
          await client.messageFlagsRemove(found, [oldKw], { uid: true });
        }
      } finally {
        lock.release();
      }
    }
  }

  async #deleteLabel(client: ImapFlow, name: string): Promise<void> {
    if (this.#gmail) {
      const existing = [...this.#serverPaths].find((p) => p.toLowerCase() === name.toLowerCase());
      if (!existing) return;
      // Deleting a Gmail label keeps every message (they stay in All Mail).
      await client.mailboxDelete(existing);
      this.#serverPaths.delete(existing);
      return;
    }
    const kw = labelToKeyword(name);
    for (const box of this.#syncedMailboxes()) {
      if (!(this.#keywordsOk.get(box.path) ?? true)) continue;
      const lock = await client.getMailboxLock(box.path);
      try {
        const found = await client.search({ keyword: kw }, { uid: true });
        if (Array.isArray(found) && found.length > 0) await client.messageFlagsRemove(found, [kw], { uid: true });
      } finally {
        lock.release();
      }
    }
  }
}
