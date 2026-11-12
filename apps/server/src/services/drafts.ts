import type { Address, Draft, DraftAttachment, DraftInput } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import { toContractDraft } from "../store/drafts.ts";
import type { AccountRecord, DraftRecord } from "../store/types.ts";
import { agentDisplayName, canSee, isAgent, requireAccess, visibleAccountIds } from "./context.ts";
import type { CallContext } from "./context.ts";
import { invalidate, notifyOutbox, writeActivity } from "./env.ts";
import type { ServiceEnv } from "./env.ts";
import { reopenThreads, waitQuietly } from "./threads.ts";

export type DraftUndo = { type: "draftCreate"; draftId: string };

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export function isValidEmail(address: string): boolean {
  return EMAIL.test(address.trim());
}

function cleanAddresses(list: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of list) {
    const address = a.address.trim();
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push({ name: a.name?.trim() || null, address });
  }
  return out;
}

function quoted(subject: string): string {
  const s = subject.trim() || "(no subject)";
  return `“${s.length > 60 ? `${s.slice(0, 57)}…` : s}”`;
}

export function createDraftsService(env: ServiceEnv) {
  const { store } = env;

  /** Sends waiting out their Undo time (in memory: quitting the app cancels them). */
  const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number; ctx: CallContext }>();

  function out(d: DraftRecord): Draft {
    return { ...toContractDraft(d), sendAt: waiting.get(d.id)?.at ?? null };
  }

  function stopWaiting(id: string): { ctx: CallContext } | null {
    const w = waiting.get(id);
    if (!w) return null;
    clearTimeout(w.timer);
    waiting.delete(id);
    return w;
  }

  /** Hands a queued draft to the sync engine, and logs it as sent. */
  function dispatch(id: string, ctx: CallContext): void {
    waiting.delete(id);
    const draft = store.drafts.get(id);
    if (!draft || draft.sendState !== "queued") return;
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
    const to = recipients[0];
    const others = recipients.length > 1 ? ` and ${recipients.length - 1} more` : "";
    const activity = writeActivity(env, {
      actor: ctx.actor,
      summary: `Sent ${quoted(draft.subject)} to ${to ? to.name || to.address : "nobody"}${others}${isAgent(ctx) ? ` (for you, by ${agentDisplayName(ctx.actor.kind === "agent" ? ctx.actor.name : "")})` : ""}`,
      kind: "send",
      threadIds: [draft.threadId],
      accountIds: [draft.accountId],
      undo: null,
    });
    invalidate(env, ["activity"]);
    env.bus.publish({ type: "activity", activity });
    env.sync().sendDraft(id);
  }

  function requireDraft(id: string, ctx: CallContext): { draft: DraftRecord; account: AccountRecord } {
    const draft = store.drafts.get(id);
    const account = draft ? store.accounts.get(draft.accountId) : null;
    if (!draft || !account || draft.sendState === "sent" || !canSee(ctx, account)) {
      throw new AppError("not_found", `No draft with id ${id}. It may have been sent or deleted.`);
    }
    return { draft, account };
  }

  function requireAccount(id: string, ctx: CallContext): AccountRecord {
    const account = store.accounts.get(id);
    if (!account || !canSee(ctx, account)) throw new AppError("not_found", `No account with id ${id}.`);
    return account;
  }

  /** Attachments come from uploads or from messages (forwarding); their details are ours, not the caller's. */
  function resolveAttachments(list: DraftAttachment[], ctx: CallContext): DraftAttachment[] {
    return list.map((a) => {
      const upload = store.uploads.get(a.id);
      if (upload) return { id: upload.id, filename: upload.filename, mimeType: upload.mimeType, size: upload.size };
      const att = store.messages.attachment(a.id);
      if (att) {
        const message = store.messages.get(att.messageId);
        const account = message ? store.accounts.get(message.accountId) : null;
        if (account && canSee(ctx, account)) return { id: att.id, filename: att.filename, mimeType: att.mimeType, size: att.size };
      }
      throw new AppError("bad_request", `The attachment ${a.filename || a.id} isn't available any more. Attach it again.`);
    });
  }

  function publish(threadId: string): void {
    invalidate(env, ["drafts", "threads"], [threadId]);
  }

  const service = {
    get(id: string, ctx: CallContext): Draft {
      return out(requireDraft(id, ctx).draft);
    },

    record(id: string): DraftRecord | null {
      return store.drafts.get(id);
    },

    list(ctx?: CallContext): Draft[] {
      const visible = ctx ? visibleAccountIds(ctx, store.accounts.list()) : null;
      return store.drafts.list(visible).map(toContractDraft);
    },

    listForThread(threadId: string, ctx?: CallContext): Draft[] {
      const thread = store.threads.get(threadId);
      if (ctx && thread) {
        const account = store.accounts.get(thread.account_id);
        if (!account || !canSee(ctx, account)) return [];
      }
      return store.drafts.forThread(threadId).map(toContractDraft);
    },

    save(input: DraftInput, ctx: CallContext): Draft {
      const now = env.now();
      const existing = input.id ? requireDraft(input.id, ctx).draft : null;
      if (existing && (existing.sendState === "queued" || existing.sendState === "sending")) {
        throw new AppError("conflict", "This draft is being sent and can't be changed now.");
      }
      const account = requireAccount(input.accountId, ctx);
      requireAccess(ctx, account, "draft", "writing drafts");
      if (existing && existing.accountId !== account.id) {
        const before = store.accounts.get(existing.accountId);
        if (before) requireAccess(ctx, before, "draft", "moving a draft to another account");
      }

      // Which conversation it belongs to.
      let threadId: string;
      let sourceMessageId = input.sourceMessageId;
      if (input.mode === "new") {
        threadId = existing && existing.mode === "new" ? existing.threadId : newId("thr");
        sourceMessageId = null;
      } else {
        let wanted = input.threadId;
        if (sourceMessageId) {
          const source = store.messages.get(sourceMessageId);
          if (!source || source.accountId !== account.id) {
            throw new AppError("bad_request", `No message ${sourceMessageId} in ${account.email} to answer or forward.`);
          }
          if (wanted && wanted !== source.threadId) throw new AppError("bad_request", "The message isn't in that conversation.");
          wanted = source.threadId;
        }
        if (!wanted) throw new AppError("bad_request", "A reply or forward needs the conversation it belongs to (threadId).");
        const thread = store.threads.get(wanted);
        if (!thread || thread.account_id !== account.id) {
          throw new AppError("bad_request", `No conversation ${wanted} in ${account.email}. Replies are written from the conversation's own account.`);
        }
        threadId = wanted;
        if (!sourceMessageId) {
          const messages = store.messages.forThread(threadId).filter((m) => !m.isDraft);
          sourceMessageId = messages.at(-1)?.id ?? null;
        }
      }

      for (const a of [...input.to, ...input.cc, ...input.bcc]) {
        if (a.address.trim() && !isValidEmail(a.address)) throw new AppError("bad_request", `"${a.address}" isn't an email address.`);
      }

      const record: DraftRecord = {
        id: existing?.id ?? newId("drf"),
        accountId: account.id,
        mode: input.mode,
        threadId,
        sourceMessageId,
        to: cleanAddresses(input.to),
        cc: cleanAddresses(input.cc),
        bcc: cleanAddresses(input.bcc),
        subject: input.subject,
        bodyText: input.bodyText,
        attachments: resolveAttachments(input.attachments, ctx),
        createdBy: existing?.createdBy ?? ctx.actor,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        sendState: "draft",
        sendError: null,
        remoteUid: existing?.remoteUid ?? null,
        remoteMailboxId: existing?.remoteMailboxId ?? null,
      };

      let activity: ReturnType<typeof writeActivity> | null = null;
      env.db.tx(() => {
        if (input.mode === "new") store.threads.insertPlaceholder(threadId, account.id, now);
        store.drafts.upsert(record);
        const refresh = [threadId];
        if (existing && existing.threadId !== threadId) refresh.push(existing.threadId);
        store.refreshThreads(refresh);
        if (!existing && isAgent(ctx)) {
          activity = writeActivity(env, {
            actor: ctx.actor,
            summary: input.mode === "new" ? `Drafted ${quoted(record.subject)}` : `Drafted a reply to ${quoted(record.subject.replace(/^(re|aw|fwd?|wg):\s*/i, ""))}`,
            kind: "draft",
            threadIds: [threadId],
            accountIds: [account.id],
            undo: { type: "draftCreate", draftId: record.id } satisfies DraftUndo,
          });
        }
      });
      publish(threadId);
      if (existing && existing.threadId !== threadId) publish(existing.threadId);
      if (activity) {
        invalidate(env, ["activity"]);
        env.bus.publish({ type: "activity", activity });
      }
      return out(record);
    },

    delete(id: string, ctx: CallContext): void {
      const { draft, account } = requireDraft(id, ctx);
      requireAccess(ctx, account, "draft", "deleting drafts");
      service.discard(draft);
    },

    /** Removes a draft row (and its server copy later); used by delete and undo. */
    discard(draft: DraftRecord): void {
      stopWaiting(draft.id);
      env.db.tx(() => {
        store.drafts.delete(draft.id);
        store.refreshThreads([draft.threadId]);
        if (draft.remoteUid !== null && !store.accounts.isDemo(draft.accountId)) {
          store.outbox.enqueue(draft.accountId, {
            kind: "deleteDraft",
            draftId: draft.id,
            remoteUid: draft.remoteUid,
            mailboxId: draft.remoteMailboxId,
          });
        }
      });
      if (draft.remoteUid !== null) notifyOutbox(env, [draft.accountId]);
      publish(draft.threadId);
    },

    send(id: string, ctx: CallContext, options: { undoable?: boolean; waitUntil?: number | null } = {}): Draft {
      const { draft, account } = requireDraft(id, ctx);
      requireAccess(ctx, account, "send", "sending mail");
      if (draft.sendState === "queued" || draft.sendState === "sending") return out(draft);
      const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
      if (recipients.length === 0) throw new AppError("bad_request", "Add at least one recipient before sending.");
      const bad = recipients.find((a) => !isValidEmail(a.address));
      if (bad) throw new AppError("bad_request", `"${bad.address}" isn't an email address.`);
      for (const a of draft.attachments) {
        if (!store.uploads.get(a.id) && !store.messages.attachment(a.id)) {
          throw new AppError("bad_request", `The attachment ${a.filename} isn't available any more. Attach it again.`);
        }
      }
      store.drafts.setSendState(draft.id, "queued", null);
      store.drafts.setWaitUntil(draft.id, options.waitUntil && options.waitUntil > env.now() ? options.waitUntil : null);
      const wait = options.undoable && !isAgent(ctx) ? store.settings.get().undoSendSeconds * 1000 : 0;
      if (wait > 0) {
        const timer = setTimeout(() => dispatch(draft.id, ctx), wait);
        timer.unref?.();
        waiting.set(draft.id, { timer, at: Date.now() + wait, ctx });
      }
      publish(draft.threadId);
      const result = out(store.drafts.get(draft.id)!);
      if (wait === 0) dispatch(draft.id, ctx);
      return result;
    },

    /** Undo send: stops a send that is still waiting; the message is a draft again. */
    cancelSend(id: string, ctx: CallContext): Draft {
      const { draft, account } = requireDraft(id, ctx);
      requireAccess(ctx, account, "send", "stopping a send");
      if (!stopWaiting(draft.id)) {
        if (draft.sendState === "queued" || draft.sendState === "sending") {
          throw new AppError("conflict", "Too late: it's already on its way.");
        }
        return out(draft);
      }
      store.drafts.setSendState(draft.id, "draft", null);
      publish(draft.threadId);
      return out(store.drafts.get(draft.id)!);
    },

    /** Sends a waiting message now. */
    sendNow(id: string, ctx: CallContext): void {
      const { draft, account } = requireDraft(id, ctx);
      requireAccess(ctx, account, "send", "sending mail");
      const w = stopWaiting(draft.id);
      if (w) dispatch(draft.id, w.ctx);
    },

    /**
     * At startup: sends that were waiting when the app quit didn't go out, so they are drafts
     * again; one that was mid-send may or may not have left.
     */
    recoverInterrupted(): void {
      const stuck = store.drafts.list(null).filter((d) => d.sendState === "queued" || d.sendState === "sending");
      if (stuck.length === 0) return;
      env.db.tx(() => {
        for (const d of stuck) {
          if (d.sendState === "queued") store.drafts.setSendState(d.id, "draft", null);
          else store.drafts.setSendState(d.id, "failed", "Fancy Mail closed while this was being sent. Check Sent before sending it again.");
        }
      });
      invalidate(env, ["drafts", "threads"]);
    },

    /** Sync engine: the draft is going out now. */
    markSending(id: string): void {
      const draft = store.drafts.get(id);
      if (!draft) return;
      store.drafts.setSendState(id, "sending", null);
      publish(draft.threadId);
    },

    /**
     * Sync engine: the message left. Deletes the draft (the sent message is already in the
     * thread, or arrives with the next sync) and tells the client.
     */
    markSent(id: string, extraThreadIds: string[] = []): void {
      const draft = store.drafts.get(id);
      if (!draft) return;
      const waitUntil = store.drafts.waitUntil(id);
      env.db.tx(() => {
        store.drafts.delete(id);
        store.refreshThreads([draft.threadId, ...extraThreadIds]);
      });
      invalidate(env, ["drafts", "threads", "mailboxes", "accounts"], [draft.threadId, ...extraThreadIds]);
      // You wrote: it's active again (settled, waiting or snoozed before), or, with "Send and
      // wait", waiting for the answer.
      const threads = [...new Set([...extraThreadIds, draft.threadId])].filter((t) => store.threads.get(t) !== null);
      reopenThreads(env, threads, { marks: false });
      if (waitUntil && waitUntil > env.now()) waitQuietly(env, threads.slice(0, 1), waitUntil);
      env.bus.publish({ type: "draftSent", draftId: id, ok: true, error: null });
    },

    /** Sync engine: sending failed; the draft stays, with the reason. */
    markSendFailed(id: string, error: string): void {
      const draft = store.drafts.get(id);
      if (!draft) return;
      store.drafts.setSendState(id, "failed", error);
      publish(draft.threadId);
      env.bus.publish({ type: "draftSent", draftId: id, ok: false, error });
    },

    undo(undo: DraftUndo): string[] {
      const draft = store.drafts.get(undo.draftId);
      if (!draft) return [];
      if (draft.sendState === "queued" || draft.sendState === "sending") {
        throw new AppError("conflict", "That draft is being sent, so it can't be undone.");
      }
      service.discard(draft);
      return [draft.threadId];
    },
  };
  return service;
}

export type DraftsService = ReturnType<typeof createDraftsService>;
