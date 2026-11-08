/** Who a reply goes to, its subject and its quoted original. */
import type { Account, Address, DraftMode, Message, ThreadDetail } from "@fancy-mail/contracts";

import { formatAddress, uniqueAddresses } from "~/lib/addresses";
import { formatExact } from "~/lib/format";
import { forwardSubject, quoteText, replySubject } from "~/lib/plainText";
import type { DraftFields } from "./useDraftEditor";

/** The message a reply answers: the newest one that isn't a draft. */
export function sourceMessage(detail: ThreadDetail): Message | undefined {
  const real = detail.messages.filter((m) => !m.isDraft);
  return real[real.length - 1] ?? detail.messages[detail.messages.length - 1];
}

function isOwn(address: Address, own: Set<string>): boolean {
  return own.has(address.address.trim().toLowerCase());
}

export function recipientsFor(mode: Exclude<DraftMode, "new">, source: Message, own: Set<string>): { to: Address[]; cc: Address[] } {
  if (mode === "forward") return { to: [], cc: [] };
  const fromMe = source.from ? isOwn(source.from, own) : false;
  const primary = fromMe ? source.to : source.replyTo.length > 0 ? source.replyTo : source.from ? [source.from] : [];
  if (mode === "reply") return { to: uniqueAddresses(primary), cc: [] };
  const to = uniqueAddresses([...primary, ...(fromMe ? [] : source.to)]).filter((a) => !isOwn(a, own));
  const toKeys = new Set(to.map((a) => a.address.toLowerCase()));
  const cc = uniqueAddresses(source.cc).filter((a) => !isOwn(a, own) && !toKeys.has(a.address.toLowerCase()));
  return { to: to.length > 0 ? to : uniqueAddresses(primary), cc };
}

function bodyText(message: Message): string {
  if (message.body?.text) return message.body.text;
  if (message.body?.html) {
    const doc = new DOMParser().parseFromString(message.body.html, "text/html");
    doc.querySelectorAll("style,script,head").forEach((el) => el.remove());
    return (doc.body.innerText || doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }
  return message.snippet;
}

export function quoteFor(mode: Exclude<DraftMode, "new">, source: Message): string {
  const sender = source.from ? formatAddress(source.from) : "someone";
  if (mode === "forward") {
    const lines = [
      "---------- Forwarded message ---------",
      `From: ${sender}`,
      `Date: ${formatExact(source.date)}`,
      `Subject: ${source.subject}`,
      `To: ${source.to.map(formatAddress).join(", ")}`,
      ...(source.cc.length > 0 ? [`Cc: ${source.cc.map(formatAddress).join(", ")}`] : []),
      "",
      bodyText(source),
    ];
    return lines.join("\n");
  }
  return `On ${formatExact(source.date)} ${sender} wrote:\n${quoteText(bodyText(source))}`;
}

export function signatureText(account: Account | undefined): string {
  const signature = account?.signature?.trim();
  return signature ? `\n\n-- \n${signature}` : "";
}

export function replyFields(mode: Exclude<DraftMode, "new">, detail: ThreadDetail, account: Account | undefined, own: Set<string>): DraftFields {
  const source = sourceMessage(detail);
  const { to, cc } = source ? recipientsFor(mode, source, own) : { to: [], cc: [] };
  const subject = source?.subject ?? detail.thread.subject;
  return {
    accountId: detail.thread.accountId,
    mode,
    threadId: detail.thread.id,
    sourceMessageId: source?.id ?? null,
    to,
    cc,
    bcc: [],
    subject: mode === "forward" ? forwardSubject(subject) : replySubject(subject),
    text: signatureText(account),
    quote: source ? quoteFor(mode, source) : null,
    attachments: [],
  };
}
