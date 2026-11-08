/**
 * A downloaded message source → the body the reader shows, the text the index searches, the
 * snippet, and the attachment files on disk.
 */
import fs from "node:fs";
import path from "node:path";

import { convert } from "html-to-text";
import { simpleParser } from "mailparser";

import { newId } from "../db/ids.ts";
import { safeFilename } from "../services/files.ts";
import type { Store } from "../store/index.ts";
import type { AttachmentRecord } from "../store/types.ts";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  content: Buffer;
}

export interface ParsedBody {
  text: string;
  html: string | null;
  snippet: string;
  attachments: ParsedAttachment[];
}

export function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function htmlText(html: string): string {
  try {
    return convert(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { ignoreHref: true } },
        { selector: "style", format: "skip" },
        { selector: "script", format: "skip" },
      ],
    }).trim();
  } catch {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
}

export async function parseSource(source: Buffer): Promise<ParsedBody> {
  const parsed = await simpleParser(source, {
    keepCidLinks: true,
    skipImageLinks: true,
    skipTextToHtml: true,
    skipHtmlToText: true,
  });
  const html = typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : null;
  const plain = typeof parsed.text === "string" ? parsed.text : "";
  const text = plain.trim() ? plain : html ? htmlText(html) : "";
  const attachments: ParsedAttachment[] = (parsed.attachments ?? []).map((a) => {
    const contentId = a.contentId ? a.contentId.replace(/^<|>$/g, "").trim() || null : (a.cid ?? null);
    const mimeType = (a.contentType || "application/octet-stream").toLowerCase();
    const inline = a.contentDisposition !== "attachment" && contentId !== null && mimeType.startsWith("image/");
    return {
      filename: a.filename?.trim() || (mimeType === "message/rfc822" ? "message.eml" : mimeType.startsWith("image/") ? `image.${mimeType.slice(6) || "png"}` : "attachment"),
      mimeType,
      size: a.content.length,
      contentId,
      inline,
      content: a.content,
    };
  });
  return { text, html, snippet: snippetOf(text), attachments };
}

/**
 * Pairs parsed attachments with the rows made from the BODYSTRUCTURE: same Content-ID, else the
 * same file name, else the next row of the same type, in order. Returns the row index for each
 * parsed attachment (-1: no row, insert one).
 */
export function matchAttachments(rows: Pick<AttachmentRecord, "filename" | "mimeType" | "contentId">[], parsed: Pick<ParsedAttachment, "filename" | "mimeType" | "contentId">[]): number[] {
  const used = new Set<number>();
  const out = parsed.map(() => -1);
  const rounds: ((r: (typeof rows)[number], p: (typeof parsed)[number]) => boolean)[] = [
    (r, p) => p.contentId !== null && r.contentId === p.contentId,
    (r, p) => r.filename === p.filename,
    (r, p) => r.mimeType === p.mimeType,
  ];
  for (const same of rounds) {
    parsed.forEach((p, i) => {
      if (out[i] !== -1) return;
      const index = rows.findIndex((r, j) => !used.has(j) && same(r, p));
      if (index >= 0) {
        used.add(index);
        out[i] = index;
      }
    });
  }
  return out;
}

/**
 * Stores a parsed body: files under <dataDir>/attachments/<account>/<message>/, rows matched or
 * added, the body and snippet, and the thread cache. Runs in one transaction (files first).
 */
export function storeParsedBody(store: Store, dataDir: string, message: { id: string; accountId: string; threadId: string }, body: ParsedBody, now: number): void {
  const rows = store.messages.attachments([message.id]);
  const assignment = matchAttachments(rows, body.attachments);
  const dir = path.join(dataDir, "attachments", message.accountId, message.id);
  const files: (string | null)[] = body.attachments.map((a, index) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${index}-${safeFilename(a.filename)}`);
      fs.writeFileSync(file, a.content);
      return file;
    } catch {
      return null;
    }
  });
  store.db.tx(() => {
    body.attachments.forEach((a, index) => {
      const rowIndex = assignment[index]!;
      if (rowIndex >= 0) {
        store.messages.setAttachmentPath(rows[rowIndex]!.id, files[index] ?? null);
      } else {
        store.messages.insertAttachment({
          id: newId("att"),
          messageId: message.id,
          part: null,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          contentId: a.contentId,
          inline: a.inline,
          localPath: files[index] ?? null,
          sortOrder: rows.length + index,
        });
      }
    });
    const hasFiles = body.attachments.some((a) => !a.inline) || rows.some((r) => !r.inline);
    store.messages.update(message.id, { snippet: body.snippet, hasAttachments: hasFiles, bodyAttempts: 0 });
    store.messages.setBody(message.id, { text: body.text, html: body.html }, now);
    store.refreshThreads([message.threadId]);
  });
}
