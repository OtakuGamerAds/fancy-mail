/**
 * The real sync engine. Demo accounts keep using the local-only engine; every real account gets
 * one AccountWorker (worker.ts). At most four accounts run their first sync at the same time.
 *
 * Sending happens here (SMTP needs no IMAP connection); the Sent copy is appended through the
 * account's worker when it is connected, or a short-lived connection when it isn't.
 */
import fs from "node:fs";

import type { Provider, ServerEndpoint } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import { invalidate } from "../services/env.ts";
import type { AccountRecord, DraftRecord, MailboxRecord } from "../store/types.ts";
import { classifyError, smtpSendMessage } from "./errors.ts";
import { checkImapLogin, createImapClient, looksLikeGoogle } from "./imap.ts";
import type { ImapAuth } from "./imap.ts";
import { createLocalOnlySync } from "./localOnly.ts";
import { createOAuth } from "./oauth.ts";
import { Semaphore } from "./signal.ts";
import { buildMessage, checkSmtpLogin, createSmtpTransport, storeSentMessage } from "./smtp.ts";
import type { OutgoingFile, SmtpAuth } from "./smtp.ts";
import { createSyncStore } from "./syncStore.ts";
import type { SyncDeps, SyncEngine } from "./types.ts";
import { AccountWorker } from "./worker.ts";

const INITIAL_SYNC_SLOTS = 4;
const TEST_TIMEOUT_MS = 20_000;

export function createSyncEngine(deps: SyncDeps): SyncEngine {
  const { store, services, log, config } = deps;
  const local = createLocalOnlySync(deps);
  const syncStore = createSyncStore(deps.db, store);
  const workers = new Map<string, AccountWorker>();
  const initialSlots = new Semaphore(INITIAL_SYNC_SLOTS);
  const settings = () => services.settings.get();
  let started = false;

  const oauth = createOAuth({
    store,
    vault: deps.vault,
    bus: deps.bus,
    log: log.child("oauth"),
    settings,
    now: () => services.env.now(),
    onAccount(accountId, created) {
      if (created) engine.accountAdded(accountId);
      else engine.accountUpdated(accountId);
    },
    invalidate: () => invalidate(services.env, ["accounts", "groups", "mailboxes"]),
  });

  function isReal(accountId: string): boolean {
    const account = store.accounts.get(accountId);
    return account !== null && !account.isDemo;
  }

  function ensureWorker(accountId: string): AccountWorker | null {
    if (!started || !isReal(accountId)) return null;
    let worker = workers.get(accountId);
    if (!worker) {
      worker = new AccountWorker(accountId, {
        db: deps.db,
        store,
        syncStore,
        services,
        bus: deps.bus,
        vault: deps.vault,
        config,
        log,
        oauth,
        initialSlots,
        settings,
      });
      workers.set(accountId, worker);
      worker.start();
    }
    return worker;
  }

  async function smtpAuth(account: AccountRecord): Promise<SmtpAuth> {
    const user = account.username || account.email;
    if (account.authKind === "password") {
      const pass = deps.vault.get(account.id, "password");
      if (!pass) throw new AppError("auth_failed", "The saved password can't be read on this computer any more. Reconnect the account and try again.");
      log.addSecret(pass);
      return { user, pass };
    }
    return { user, accessToken: await oauth.accessToken(account) };
  }

  /** The files of a draft, on this computer (attachments forwarded from a message are downloaded first). */
  async function draftFiles(draft: DraftRecord): Promise<OutgoingFile[]> {
    const out: OutgoingFile[] = [];
    for (const a of draft.attachments) {
      const upload = store.uploads.get(a.id);
      if (upload && fs.existsSync(upload.path)) {
        out.push({ filename: upload.filename, mimeType: upload.mimeType, path: upload.path, size: upload.size });
        continue;
      }
      const att = store.messages.attachment(a.id);
      if (att) {
        const file = att.localPath && fs.existsSync(att.localPath) ? att.localPath : await engine.downloadAttachment(att.id);
        out.push({ filename: att.filename, mimeType: att.mimeType, path: file, size: att.size });
        continue;
      }
      throw new AppError("bad_request", `The attachment ${a.filename} isn't available any more. Attach it again.`);
    }
    return out;
  }

  function sentMailbox(account: AccountRecord): MailboxRecord {
    const sent = store.mailboxes.byRole(account.id, "sent");
    if (sent) return sent;
    // No Sent folder known yet: a local one, created on the server by the outbox.
    const mailbox: MailboxRecord = {
      id: newId("mbx"),
      accountId: account.id,
      path: "Sent",
      name: "Sent",
      role: "sent",
      delimiter: "/",
      specialUse: null,
      uidvalidity: null,
      uidnext: null,
      highestmodseq: null,
      sync: null,
      selectable: true,
      createdLocally: true,
    };
    store.db.tx(() => {
      store.mailboxes.insert(mailbox);
      store.outbox.enqueue(account.id, { kind: "createMailbox", mailbox: { id: mailbox.id, path: mailbox.path, role: mailbox.role } });
    });
    workers.get(account.id)?.notifyOutbox();
    return mailbox;
  }

  /** Saves the Sent copy on servers that don't do it themselves. Returns its uid when known. */
  async function appendSent(account: AccountRecord, mailbox: MailboxRecord, raw: Buffer): Promise<number | null> {
    const worker = workers.get(account.id);
    try {
      const viaWorker = await worker?.append(mailbox.path, raw, ["\\Seen"]);
      if (viaWorker) return viaWorker.uid;
    } catch (error) {
      log.warn("could not save the sent copy with the open connection", { accountId: account.id, error: (error as Error).message });
    }
    if (!account.imap) return null;
    const auth: ImapAuth = await smtpAuth(account);
    const client = createImapClient(account.imap, auth, log, { noIdle: true, connectionTimeout: TEST_TIMEOUT_MS });
    try {
      await client.connect();
      if (mailbox.createdLocally) {
        await client.mailboxCreate(mailbox.path).catch(() => undefined);
      }
      const result = await client.append(mailbox.path, raw, ["\\Seen"]);
      await client.logout().catch(() => undefined);
      return result && typeof result.uid === "number" ? result.uid : null;
    } finally {
      client.close();
    }
  }

  async function send(draftId: string): Promise<void> {
    const draft = store.drafts.get(draftId);
    if (!draft || draft.sendState !== "queued") return;
    const account = store.accounts.get(draft.accountId);
    if (!account) {
      services.drafts.markSendFailed(draftId, "The account of this draft was removed.");
      return;
    }
    if (!account.smtp) {
      services.drafts.markSendFailed(draftId, "This account has no outgoing mail server set, so it can't send.");
      return;
    }
    services.drafts.markSending(draftId);
    const ctx = { host: account.smtp.host, provider: account.provider, mode: "test" as const, protocol: "smtp" as const, email: account.email };
    let built;
    let files: OutgoingFile[];
    try {
      files = await draftFiles(draft);
      const source = draft.sourceMessageId ? store.messages.get(draft.sourceMessageId) : null;
      built = await buildMessage({ account, draft, source, files });
      const auth = await smtpAuth(account);
      const transport = createSmtpTransport(account.smtp, auth);
      try {
        await transport.sendMail({ envelope: built.envelope, raw: built.raw });
      } finally {
        transport.close();
      }
    } catch (error) {
      const message = error instanceof AppError ? error.message : smtpSendMessage(error, ctx);
      log.warn("send failed", { draftId, error: error instanceof Error ? error.message : String(error) });
      services.drafts.markSendFailed(draftId, message);
      return;
    }

    // It left. From here on nothing may report a failure (that would invite a second send).
    let threadIds: string[] = [];
    try {
      const gmail = workers.get(account.id)?.isGmail ?? store.mailboxes.byRole(account.id, "all") !== null;
      const sent = sentMailbox(account);
      let sentUid: number | null = null;
      if (!gmail) {
        try {
          sentUid = await appendSent(account, sent, built.rawForSent);
        } catch (error) {
          log.warn("the message was sent, but saving it in Sent failed", { draftId, error: (error as Error).message });
        }
      }
      const stored = storeSentMessage({
        store,
        dataDir: config.dataDir,
        account,
        draft,
        built,
        files,
        sent,
        all: gmail ? store.mailboxes.byRole(account.id, "all") : null,
        sentUid,
      });
      threadIds = [stored.threadId];
      workers.get(account.id)?.resetIndex();
    } catch (error) {
      log.error("the message was sent, but storing it locally failed", { draftId, error });
    }
    services.drafts.markSent(draftId, threadIds);
    workers.get(account.id)?.syncNowQuiet();
  }

  function guessProvider(email: string, imap: ServerEndpoint): Provider {
    return looksLikeGoogle("imap", imap.host) || /@(gmail|googlemail)\.com$/i.test(email) ? "gmail" : "imap";
  }

  const engine: SyncEngine = {
    start() {
      started = true;
      local.start();
      for (const account of store.accounts.list()) {
        if (!account.isDemo) ensureWorker(account.id);
      }
    },

    async stop() {
      started = false;
      oauth.stop();
      const all = [...workers.values()];
      workers.clear();
      await Promise.all(all.map((w) => w.stop().catch((error) => log.warn("worker stop failed", { error }))));
      await local.stop();
    },

    requestBodies(messageIds) {
      const byAccount = new Map<string, string[]>();
      for (const m of store.messages.byIds(messageIds)) {
        const list = byAccount.get(m.accountId) ?? [];
        list.push(m.id);
        byAccount.set(m.accountId, list);
      }
      for (const [accountId, ids] of byAccount) {
        const worker = ensureWorker(accountId);
        if (worker) worker.requestBodies(ids);
        else local.requestBodies(ids);
      }
    },

    async downloadAttachment(attachmentId) {
      const att = store.messages.attachment(attachmentId);
      if (!att) throw new AppError("not_found", "This attachment's message was deleted.");
      if (att.localPath && fs.existsSync(att.localPath)) return att.localPath;
      const message = store.messages.get(att.messageId);
      const worker = message ? ensureWorker(message.accountId) : null;
      if (!worker) return local.downloadAttachment(attachmentId);
      return worker.downloadAttachment(attachmentId);
    },

    notifyOutbox(accountId) {
      const worker = ensureWorker(accountId);
      if (worker) worker.notifyOutbox();
      else local.notifyOutbox(accountId);
    },

    syncNow(accountId) {
      if (accountId) {
        const worker = ensureWorker(accountId);
        if (worker) worker.syncNow();
        else local.syncNow(accountId);
        return;
      }
      for (const account of store.accounts.list()) {
        if (account.isDemo) continue;
        ensureWorker(account.id)?.syncNow();
      }
      local.syncNow();
    },

    async testPasswordAccount(input) {
      const provider = guessProvider(input.email, input.imap);
      try {
        await checkImapLogin(input.imap, { user: input.username, pass: input.password }, log, TEST_TIMEOUT_MS);
      } catch (error) {
        const c = classifyError(error, { host: input.imap.host, provider, mode: "test", protocol: "imap", email: input.email });
        log.info("sign-in check failed (IMAP)", { host: input.imap.host, kind: c.kind });
        throw new AppError(c.kind === "auth" ? "auth_failed" : "connection_failed", c.message);
      }
      try {
        await checkSmtpLogin(input.smtp, { user: input.username, pass: input.password }, TEST_TIMEOUT_MS);
      } catch (error) {
        const c = classifyError(error, { host: input.smtp.host, provider, mode: "test", protocol: "smtp", email: input.email });
        log.info("sign-in check failed (SMTP)", { host: input.smtp.host, kind: c.kind });
        throw new AppError(c.kind === "auth" ? "auth_failed" : "connection_failed", `Receiving mail works, but sending doesn't: ${c.message}`);
      }
    },

    accountAdded(accountId) {
      if (!isReal(accountId)) {
        local.accountAdded(accountId);
        return;
      }
      ensureWorker(accountId);
    },

    accountRemoved(accountId) {
      const worker = workers.get(accountId);
      workers.delete(accountId);
      oauth.forget(accountId);
      if (worker) void worker.stop().catch((error) => log.warn("worker stop failed", { error }));
      local.accountRemoved(accountId);
    },

    accountUpdated(accountId) {
      const worker = ensureWorker(accountId);
      if (worker) worker.updated();
      else local.accountUpdated(accountId);
    },

    sendDraft(draftId) {
      const draft = store.drafts.get(draftId);
      if (!draft) return;
      if (!isReal(draft.accountId)) {
        local.sendDraft(draftId);
        return;
      }
      void send(draftId).catch((error) => {
        log.error("send crashed", { draftId, error });
        const current = store.drafts.get(draftId);
        if (current && (current.sendState === "queued" || current.sendState === "sending")) {
          services.drafts.markSendFailed(draftId, "Sending failed. Check the Sent folder before trying again.");
        }
      });
    },

    startOAuth(input) {
      return oauth.start(input);
    },

    cancelOAuth(flowId) {
      oauth.cancel(flowId);
    },
  };
  return engine;
}
