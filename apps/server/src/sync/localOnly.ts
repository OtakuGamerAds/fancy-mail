/**
 * The engine for demo accounts, and the default until the real one is wired in. Nothing here
 * talks to a network: bodies are already stored, attachments are local files, outbox ops for
 * demo accounts are dropped, and "sending" turns the draft into a message in Sent.
 */
import fs from "node:fs";
import path from "node:path";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import { safeFilename } from "../services/files.ts";
import type { DraftRecord, MailboxRecord } from "../store/types.ts";
import type { SyncDeps, SyncEngine } from "./types.ts";

const SEND_DELAY_MS = 700;
const NOT_WIRED = "Signing in to real accounts isn't wired up yet in this build.";

export function createLocalOnlySync(deps: SyncDeps): SyncEngine {
  const { store, services, log } = deps;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  function sentMailbox(accountId: string): MailboxRecord {
    const sent = store.mailboxes.byRole(accountId, "sent");
    if (sent) return sent;
    const mailbox: MailboxRecord = {
      id: newId("mbx"),
      accountId,
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
    store.mailboxes.insert(mailbox);
    return mailbox;
  }

  /** Writes the sent message into the draft's thread (a new message starts its own). */
  function deliver(draft: DraftRecord): string[] {
    const account = store.accounts.get(draft.accountId);
    if (!account) throw new AppError("not_found", "The account of this draft was removed.");
    const now = services.env.now();
    const messageId = newId("msg");
    const domain = account.email.split("@")[1] ?? "mail.example";
    const header = `<${messageId.slice(4)}@${domain}>`;
    const source = draft.sourceMessageId ? store.messages.get(draft.sourceMessageId) : null;
    const references = source ? [...source.references, ...(source.messageIdHeader ? [source.messageIdHeader] : [])] : [];
    const signature = account.signature.trim();
    const text = signature && !draft.bodyText.includes(signature) ? `${draft.bodyText}\n\n-- \n${signature}` : draft.bodyText;
    let threadId = draft.threadId;

    deps.db.tx(() => {
      store.messages.insert({
        id: messageId,
        accountId: account.id,
        threadId,
        remoteId: header,
        gmThreadId: null,
        messageIdHeader: header,
        inReplyTo: source?.messageIdHeader ?? null,
        references,
        subject: draft.subject,
        from: { name: account.senderName || null, address: account.email },
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        replyTo: [],
        date: now,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
        size: Buffer.byteLength(text) + draft.attachments.reduce((s, a) => s + a.size, 0) + 800,
        unread: false,
        starred: false,
        isDraft: false,
        hasAttachments: draft.attachments.length > 0,
        bodyState: "ready",
      });
      store.messages.addLocation(messageId, sentMailbox(account.id).id, null);
      const all = store.mailboxes.byRole(account.id, "all");
      if (all) store.messages.addLocation(messageId, all.id, null);
      // Copy the attachments next to the message, so they outlive the upload.
      const dir = path.join(deps.config.dataDir, "attachments", account.id, messageId);
      draft.attachments.forEach((a, index) => {
        const from = store.uploads.get(a.id)?.path ?? store.messages.attachment(a.id)?.localPath ?? null;
        let local: string | null = null;
        if (from && fs.existsSync(from)) {
          fs.mkdirSync(dir, { recursive: true });
          local = path.join(dir, `${index}-${safeFilename(a.filename)}`);
          fs.copyFileSync(from, local);
        }
        store.messages.insertAttachment({
          id: newId("att"),
          messageId,
          part: String(index + 2),
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          contentId: null,
          inline: false,
          localPath: local,
          sortOrder: index,
        });
      });
      store.messages.setBody(messageId, { text, html: null }, now);
    });
    threadId = store.messages.get(messageId)?.threadId ?? threadId;
    return [threadId];
  }

  return {
    start() {
      stopped = false;
    },
    async stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    requestBodies() {
      // Demo bodies are stored with the messages.
    },
    async downloadAttachment(attachmentId) {
      const att = store.messages.attachment(attachmentId);
      if (att?.localPath && fs.existsSync(att.localPath)) return att.localPath;
      throw new AppError("not_found", "This attachment isn't on this computer, and this account can't download it.");
    },
    notifyOutbox(accountId) {
      // Demo accounts never reach a server: drop their ops. Real accounts wait for the real engine.
      if (store.accounts.isDemo(accountId)) {
        for (const op of store.outbox.pending(accountId)) store.outbox.complete(op.id);
      }
    },
    syncNow(accountId) {
      const ids = accountId ? [accountId] : store.accounts.demoIds();
      for (const id of ids) {
        const account = store.accounts.get(id);
        if (!account?.isDemo) continue;
        services.accounts.setStatus(id, { ...account.status, state: "ready", message: "Demo account", lastSyncAt: services.env.now() });
      }
    },
    async testPasswordAccount() {
      throw new AppError("connection_failed", NOT_WIRED);
    },
    accountAdded(accountId) {
      const account = store.accounts.get(accountId);
      if (account && !account.isDemo) {
        services.accounts.setStatus(accountId, { state: "error", message: NOT_WIRED, lastSyncAt: null, progress: null });
      }
    },
    accountRemoved() {},
    accountUpdated() {},
    sendDraft(draftId) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (stopped) return;
        const draft = store.drafts.get(draftId);
        if (!draft || draft.sendState !== "queued") return;
        if (!store.accounts.isDemo(draft.accountId)) {
          services.drafts.markSendFailed(draftId, NOT_WIRED);
          return;
        }
        try {
          services.drafts.markSending(draftId);
          const threadIds = deliver(draft);
          services.drafts.markSent(draftId, threadIds);
        } catch (error) {
          log.error("demo send failed", { draftId, error });
          services.drafts.markSendFailed(draftId, error instanceof AppError ? error.message : "Sending failed. Try again.");
        }
      }, SEND_DELAY_MS);
      timers.add(timer);
    },
    async startOAuth() {
      throw new AppError("connection_failed", NOT_WIRED);
    },
    cancelOAuth() {},
  };
}
