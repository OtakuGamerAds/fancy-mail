/**
 * What a header fetch says about a message, in the store's terms: addresses, dates, flags,
 * attachment parts from the BODYSTRUCTURE, a stable remote id.
 */
import { createHash } from "node:crypto";

import type { Address } from "@fancy-mail/contracts";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";

import { normalizeMessageId, parseMessageIds } from "./threading.ts";

export interface HeaderInfo {
  uid: number;
  /** Gmail X-GM-MSGID, else the Message-ID header, else a hash of the envelope. */
  remoteId: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  gmThreadId: string | null;
  subject: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  date: number;
  size: number;
  flags: Set<string>;
  unread: boolean;
  starred: boolean;
  isDraft: boolean;
  /** Gmail X-GM-LABELS (empty elsewhere). */
  gmailLabels: string[];
  attachments: PartInfo[];
}

export interface PartInfo {
  part: string | null;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
}

function address(a: MessageAddressObject | undefined): Address | null {
  const addr = a?.address?.trim();
  if (!addr) return null;
  const name = a?.name?.trim() || null;
  return { name: name && name !== addr ? name : null, address: addr };
}

export function addresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).map(address).filter((a): a is Address => a !== null);
}

function toTime(value: Date | string | undefined): number | null {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** The Date header, unless it is missing or absurd (then the server's arrival time). */
export function messageDate(envelopeDate: Date | string | undefined, internalDate: Date | string | undefined, now = Date.now()): number {
  const header = toTime(envelopeDate);
  const internal = toTime(internalDate);
  if (header !== null && header < now + 24 * 3600_000 && header > Date.UTC(1990, 0, 1)) return header;
  return internal ?? header ?? now;
}

/** References from the raw header block a `headers: ['references']` fetch returns. */
export function referencesFromHeaders(raw: Buffer | undefined): string[] {
  if (!raw) return [];
  const text = raw.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const match = /^references:\s*(.*)$/im.exec(text);
  return match ? parseMessageIds(match[1]) : [];
}

function decodeParam(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  return v || null;
}

/** Parts that are files: a filename, or disposition attachment, or an inline image with a Content-ID. */
export function attachmentParts(structure: MessageStructureObject | undefined): PartInfo[] {
  const out: PartInfo[] = [];
  if (!structure) return out;
  const walk = (node: MessageStructureObject, isRoot: boolean) => {
    const type = (node.type || "").toLowerCase();
    if (node.childNodes && node.childNodes.length > 0) {
      // An attached message (message/rfc822) is one file; don't look inside it.
      if (type === "message/rfc822" && !isRoot) {
        out.push(fileOf(node, type) ?? { part: node.part ?? null, filename: "message.eml", mimeType: type, size: node.size ?? 0, contentId: null, inline: false });
        return;
      }
      for (const child of node.childNodes) walk(child, false);
      return;
    }
    if (type.startsWith("multipart/")) return;
    const file = fileOf(node, type);
    if (file && !(isRoot && !file.filename)) out.push(file);
  };
  walk(structure, true);
  return out;
}

function fileOf(node: MessageStructureObject, type: string): PartInfo | null {
  const disposition = (node.disposition || "").toLowerCase();
  const filename = decodeParam(node.dispositionParameters?.filename) ?? decodeParam(node.parameters?.name);
  const contentId = node.id ? node.id.replace(/^<|>$/g, "").trim() || null : null;
  const isAttachment = disposition === "attachment";
  const isText = type === "text/plain" || type === "text/html";
  if (!isAttachment && !filename && !(contentId && !isText)) return null;
  if (isText && !isAttachment && !filename) return null;
  const inline = !isAttachment && contentId !== null && type.startsWith("image/");
  return {
    part: node.part ?? "1",
    filename: filename ?? (type.startsWith("image/") ? `image.${type.slice(6) || "png"}` : "attachment"),
    mimeType: type || "application/octet-stream",
    size: estimateDecodedSize(node),
    contentId,
    inline,
  };
}

/** BODYSTRUCTURE sizes are the encoded size; base64 is a third bigger than the file. */
function estimateDecodedSize(node: MessageStructureObject): number {
  const size = node.size ?? 0;
  return (node.encoding || "").toLowerCase() === "base64" ? Math.floor((size * 3) / 4) : size;
}

/** A stable id for a message without a Message-ID header. */
export function envelopeHash(parts: { date: number; from: Address | null; subject: string; size: number }): string {
  const h = createHash("sha1").update(`${parts.date}\n${parts.from?.address ?? ""}\n${parts.subject}\n${parts.size}`).digest("hex");
  return `fm:${h.slice(0, 32)}`;
}

export function headerInfo(msg: FetchMessageObject, gmail: boolean, now = Date.now()): HeaderInfo {
  const env = msg.envelope ?? {};
  const flags = msg.flags ?? new Set<string>();
  const messageIdHeader = normalizeMessageId(env.messageId);
  const subject = (env.subject ?? "").replace(/[\r\n]+/g, " ").trim();
  const from = address(env.from?.[0]) ?? address(env.sender?.[0]);
  const date = messageDate(env.date, msg.internalDate, now);
  const size = msg.size ?? 0;
  const gmailLabels = gmail && msg.labels ? [...msg.labels] : [];
  const remoteId = gmail && msg.emailId ? msg.emailId : (messageIdHeader ?? envelopeHash({ date, from, subject, size }));
  return {
    uid: msg.uid,
    remoteId,
    messageIdHeader,
    inReplyTo: normalizeMessageId(env.inReplyTo),
    references: referencesFromHeaders(msg.headers),
    gmThreadId: gmail && msg.threadId ? msg.threadId : null,
    subject,
    from,
    to: addresses(env.to),
    cc: addresses(env.cc),
    bcc: addresses(env.bcc),
    replyTo: addresses(env.replyTo).filter((a) => a.address.toLowerCase() !== from?.address.toLowerCase()),
    date,
    size,
    flags,
    unread: !flags.has("\\Seen"),
    starred: flags.has("\\Flagged"),
    isDraft: flags.has("\\Draft") || gmailLabels.some((l) => l.toLowerCase() === "\\draft"),
    gmailLabels,
    attachments: attachmentParts(msg.bodyStructure),
  };
}
