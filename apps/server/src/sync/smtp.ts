/**
 * Sending: build the message once (so what is saved in Sent is exactly what left), hand it to
 * the account's SMTP server, then put the sent message in its conversation right away.
 *
 * A send is never retried by itself: a timeout after the server took the message could mean it
 * left already, and a double send is worse than a "try again".
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";

import type { Address, ServerEndpoint } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { safeFilename } from "../services/files.ts";
import type { Store } from "../store/index.ts";
import type { AccountRecord, DraftRecord, MailboxRecord, MessageRecord } from "../store/types.ts";

export type SmtpAuth = { user: string; pass: string } | { user: string; accessToken: string };

export function createSmtpTransport(endpoint: ServerEndpoint, auth: SmtpAuth, timeoutMs = 30_000) {
  return nodemailer.createTransport({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    // Port 587/25: the password only goes over an upgraded (STARTTLS) connection.
    requireTLS: !endpoint.secure,
    auth: "pass" in auth ? { user: auth.user, pass: auth.pass } : { type: "OAuth2", user: auth.user, accessToken: auth.accessToken },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: Math.max(timeoutMs, 60_000),
    logger: false,
    debug: false,
  });
}

/** Signs in to SMTP and out again. Throws the raw error. */
export async function checkSmtpLogin(endpoint: ServerEndpoint, auth: SmtpAuth, timeoutMs = 20_000): Promise<void> {
  const transport = createSmtpTransport(endpoint, auth, timeoutMs);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export interface OutgoingFile {
  filename: string;
  mimeType: string;
  path: string;
  size: number;
}

export interface BuiltMessage {
  /** What goes to the SMTP server (no Bcc header). */
  raw: Buffer;
  /** What is saved in Sent (keeps Bcc, like other clients do). */
  rawForSent: Buffer;
  messageIdHeader: string;
  inReplyTo: string | null;
  references: string[];
  text: string;
  date: Date;
  envelope: { from: string; to: string[] };
}

function formatAddress(a: Address): { name: string; address: string } | string {
  return a.name ? { name: a.name, address: a.address } : a.address;
}

/** The body with the account's signature after "-- " (unless the body has it already). */
export function withSignature(body: string, signature: string): string {
  const sig = signature.replace(/\r\n/g, "\n").trim();
  if (!sig) return body;
  const normalizedBody = body.replace(/\r\n/g, "\n");
  if (normalizedBody.includes(sig)) return body;
  return `${normalizedBody.replace(/\s+$/, "")}\n\n-- \n${sig}`;
}

/** In-Reply-To and References for a reply (forwards keep only References, for threading). */
export function replyHeaders(draft: Pick<DraftRecord, "mode">, source: Pick<MessageRecord, "messageIdHeader" | "references"> | null): { inReplyTo: string | null; references: string[] } {
  if (!source?.messageIdHeader || draft.mode === "new") return { inReplyTo: null, references: [] };
  const references = [...source.references.filter((r) => r !== source.messageIdHeader), source.messageIdHeader].slice(-20);
  return { inReplyTo: draft.mode === "forward" ? null : source.messageIdHeader, references };
}

export async function buildMessage(input: {
  account: Pick<AccountRecord, "email" | "displayName" | "signature">;
  draft: DraftRecord;
  source: MessageRecord | null;
  files: OutgoingFile[];
  now?: Date;
}): Promise<BuiltMessage> {
  const { account, draft } = input;
  const domain = account.email.split("@")[1] || "fancy-mail.local";
  const messageIdHeader = `<${randomBytes(12).toString("hex")}.fm@${domain}>`;
  const text = withSignature(draft.bodyText, account.signature);
  const { inReplyTo, references } = replyHeaders(draft, input.source);
  const date = input.now ?? new Date();
  const mail = {
    from: { name: account.displayName || account.email, address: account.email },
    to: draft.to.map(formatAddress),
    cc: draft.cc.map(formatAddress),
    bcc: draft.bcc.map(formatAddress),
    subject: draft.subject,
    text,
    date,
    messageId: messageIdHeader,
    inReplyTo: inReplyTo ?? undefined,
    references: references.length > 0 ? references.join(" ") : undefined,
    attachments: input.files.map((f) => ({ filename: f.filename, contentType: f.mimeType, path: f.path })),
    headers: { "X-Mailer": "Fancy Mail" },
  };
  const build = (keepBcc: boolean) =>
    new Promise<Buffer>((resolve, reject) => {
      const node = new MailComposer(mail).compile();
      node.keepBcc = keepBcc;
      node.build((error, message) => (error ? reject(error) : resolve(message)));
    });
  const [raw, rawForSent] = await Promise.all([build(false), build(true)]);
  return {
    raw,
    rawForSent,
    messageIdHeader,
    inReplyTo,
    references,
    text,
    date,
    envelope: { from: account.email, to: [...draft.to, ...draft.cc, ...draft.bcc].map((a) => a.address) },
  };
}

/**
 * Writes the sent message into the draft's conversation (in Sent; Gmail: also All Mail), with
 * its attachments copied next to it. Returns the thread id.
 */
export function storeSentMessage(input: {
  store: Store;
  dataDir: string;
  account: AccountRecord;
  draft: DraftRecord;
  built: BuiltMessage;
  files: OutgoingFile[];
  sent: MailboxRecord;
  all: MailboxRecord | null;
  sentUid: number | null;
}): { messageId: string; threadId: string } {
  const { store, account, draft, built } = input;
  const messageId = newId("msg");
  const dir = path.join(input.dataDir, "attachments", account.id, messageId);
  store.db.tx(() => {
    store.messages.insert({
      id: messageId,
      accountId: account.id,
      threadId: draft.threadId,
      // Still our own Message-ID: the next sync matches it with the server's copy.
      remoteId: built.messageIdHeader,
      gmThreadId: null,
      messageIdHeader: built.messageIdHeader,
      inReplyTo: built.inReplyTo,
      references: built.references,
      subject: draft.subject,
      from: { name: account.displayName || null, address: account.email },
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      replyTo: [],
      date: built.date.getTime(),
      snippet: built.text.replace(/\s+/g, " ").trim().slice(0, 200),
      size: built.rawForSent.length,
      unread: false,
      starred: false,
      isDraft: false,
      hasAttachments: input.files.length > 0,
      bodyState: "ready",
    });
    store.messages.addLocation(messageId, input.sent.id, input.sentUid);
    if (input.all) store.messages.addLocation(messageId, input.all.id, null);
    input.files.forEach((f, index) => {
      let local: string | null = null;
      try {
        fs.mkdirSync(dir, { recursive: true });
        local = path.join(dir, `${index}-${safeFilename(f.filename)}`);
        fs.copyFileSync(f.path, local);
      } catch {
        local = null;
      }
      store.messages.insertAttachment({
        id: newId("att"),
        messageId,
        part: null,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        contentId: null,
        inline: false,
        localPath: local,
        sortOrder: index,
      });
    });
    store.messages.setBody(messageId, { text: built.text, html: null }, built.date.getTime());
    store.refreshThreads([draft.threadId]);
  });
  return { messageId, threadId: draft.threadId };
}
