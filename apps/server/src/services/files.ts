/** Attachments (download on demand) and uploads (files attached to drafts). */
import fs from "node:fs";
import path from "node:path";

import type { AttachmentMeta, DraftAttachment } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import { attachmentMeta } from "../store/messages.ts";
import type { AttachmentRecord } from "../store/types.ts";
import { removeFiles } from "./accounts.ts";
import { canSee } from "./context.ts";
import type { CallContext } from "./context.ts";
import type { ServiceEnv } from "./env.ts";

export const MAX_UPLOAD_BYTES = 35 * 1024 * 1024;

/** A file name that is safe on every OS (keeps Unicode, drops separators and control chars). */
export function safeFilename(name: string, fallback = "file"): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
  return cleaned && !reserved.test(cleaned) ? cleaned : fallback;
}

export function createAttachmentsService(env: ServiceEnv) {
  const { store } = env;

  function find(id: string, ctx?: CallContext): AttachmentRecord {
    const att = store.messages.attachment(id);
    const message = att ? store.messages.get(att.messageId) : null;
    const account = message ? store.accounts.get(message.accountId) : null;
    if (!att || !account || (ctx && !canSee(ctx, account))) {
      throw new AppError("not_found", `No attachment with id ${id}. Its message may have been deleted.`);
    }
    return att;
  }

  function existing(localPath: string | null): string | null {
    if (!localPath) return null;
    try {
      return fs.statSync(localPath).isFile() ? localPath : null;
    } catch {
      return null;
    }
  }

  return {
    get(id: string, ctx?: CallContext): AttachmentMeta & { localPath: string | null } {
      const att = find(id, ctx);
      return { ...attachmentMeta(att), localPath: existing(att.localPath) };
    },

    /** The inline part of a message with this Content-ID (for cid: images). */
    byContentId(messageId: string, contentId: string, ctx?: CallContext): AttachmentMeta {
      const att = store.messages.attachmentByContentId(messageId, contentId);
      if (!att) throw new AppError("not_found", "That image isn't part of the message.");
      find(att.id, ctx);
      return attachmentMeta(att);
    },

    /** Makes sure the file is on this computer; resolves with its path. */
    async open(id: string, ctx?: CallContext): Promise<{ path: string; meta: AttachmentMeta }> {
      const att = find(id, ctx);
      let local = existing(att.localPath);
      if (!local) {
        local = await env.sync().downloadAttachment(att.id);
        if (store.messages.attachment(att.id)?.localPath !== local) store.messages.setAttachmentPath(att.id, local);
      }
      const fresh = store.messages.attachment(att.id) ?? att;
      return { path: local, meta: { ...attachmentMeta(fresh), downloaded: true } };
    },
  };
}

export function createUploadsService(env: ServiceEnv) {
  const { store } = env;
  return {
    /** Saves a file the user attached to a draft. */
    async save(data: Buffer, filename: string, mimeType: string): Promise<DraftAttachment> {
      if (data.length > MAX_UPLOAD_BYTES) throw new AppError("bad_request", "Attachments can be at most 35 MB.");
      const id = newId("upl");
      const name = safeFilename(filename || "attachment");
      fs.mkdirSync(env.paths.uploads, { recursive: true });
      const file = path.join(env.paths.uploads, `${id}-${name}`);
      await fs.promises.writeFile(file, data);
      const record = {
        id,
        filename: filename.trim() || name,
        mimeType: mimeType || "application/octet-stream",
        size: data.length,
        path: file,
        createdAt: env.now(),
      };
      store.uploads.insert(record);
      return { id, filename: record.filename, mimeType: record.mimeType, size: record.size };
    },

    /** The stored file of an upload (sync engine, when sending). */
    get(id: string) {
      return store.uploads.get(id);
    },

    /** Deletes uploads older than `maxAgeMs` that no draft uses any more. */
    cleanup(maxAgeMs = 7 * 24 * 3600_000): number {
      const used = store.drafts.referencedUploadIds();
      const old = store.uploads.olderThan(env.now() - maxAgeMs).filter((u) => !used.has(u.id));
      for (const u of old) store.uploads.delete(u.id);
      removeFiles(env, old.map((u) => u.path), null);
      return old.length;
    },
  };
}

export type AttachmentsService = ReturnType<typeof createAttachmentsService>;
export type UploadsService = ReturnType<typeof createUploadsService>;
