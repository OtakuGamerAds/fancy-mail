/**
 * The demo data set: ~600 conversations over nine months in 11 accounts, so the app feels real
 * for someone with many accounts. Deterministic: the same `now` and `seed` give the same ids
 * and the same mail.
 */
import fs from "node:fs";
import path from "node:path";

import { COLOR_PALETTE, findDeletedLabel, findStateLabel } from "@fancy-mail/contracts";
import type { Actor, Address, ModifyAction } from "@fancy-mail/contracts";

import { idFromBytes } from "../db/ids.ts";
import type { IdPrefix } from "../db/ids.ts";
import { safeFilename } from "../services/files.ts";
import type { ServiceEnv } from "../services/env.ts";
import { writeActivity } from "../services/env.ts";
import { planAction, summarize } from "../services/mutate.ts";
import { ensureStateLabel } from "../services/settled.ts";
import { applyChange } from "../services/threads.ts";
import type { MailboxRecord } from "../store/types.ts";
import * as content from "./content.ts";
import type { Ctx, DemoThread, Rng } from "./content.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SPAN_DAYS = 270;

export const DEMO_LABELS: { name: string; color: string }[] = [
  { name: "Invoices", color: "#f59e0b" },
  { name: "Receipts", color: "#84cc16" },
  { name: "Taxes 2026", color: "#ef4444" },
  { name: "Sponsorships", color: "#d946ef" },
  { name: "Newsletters", color: "#64748b" },
  { name: "Travel", color: "#06b6d4" },
  { name: "Family", color: "#ec4899" },
];

const DEMO_GROUPS = [
  { name: "Business", color: "#3b82f6" },
  { name: "Channels", color: "#d946ef" },
  { name: "Banking", color: "#10b981" },
  { name: "Personal", color: "#f59e0b" },
];

type Style = "gmail" | "imap";

interface DemoAccountSpec {
  email: string;
  name: string;
  me: string;
  group: string | null;
  style: Style;
  agentAccess: "none" | "read" | "organize" | "draft" | "send";
  signature: string;
  /** Generators and how many conversations each makes. */
  mix: [(c: Ctx) => DemoThread, number][];
}

function accountsSpec(): DemoAccountSpec[] {
  const sig = "Alex · Brightwave Studio\nwww.brightwave.example";
  return [
    {
      email: "studio@brightwave.example",
      name: "Studio",
      me: "Brightwave Studio",
      group: "Business",
      style: "gmail",
      agentAccess: "draft",
      signature: sig,
      mix: [
        [(c) => content.sponsorshipThread(c, "Brightwave", "en"), 18],
        [(c) => content.platformThread(c, "en"), 8],
        [content.inviteThread, 7],
        [content.newsletterThread, 10],
        [content.partnerThread, 12],
        [content.sentOnlyThread, 6],
        [(c) => content.invoiceThread(c), 8],
        [content.spamThread, 3],
      ],
    },
    {
      email: "billing@brightwave.example",
      name: "Billing",
      me: "Brightwave Billing",
      group: "Business",
      style: "gmail",
      agentAccess: "organize",
      signature: sig,
      mix: [
        [(c) => content.invoiceThread(c), 46],
        [content.receiptThread, 24],
        [(c) => content.taxThread(c), 7],
        [content.finanzamtThread, 6],
        [content.utilityThread, 3],
      ],
    },
    {
      email: "alex@brightwave.example",
      name: "Alex",
      me: "Alex Morgan",
      group: "Business",
      style: "imap",
      agentAccess: "draft",
      signature: "Alex Morgan\nBrightwave Studio",
      mix: [
        [(c) => content.taxThread(c), 12],
        [content.inviteThread, 7],
        [content.partnerThread, 10],
        [content.sentOnlyThread, 5],
        [content.finanzamtThread, 4],
        [content.newsletterThread, 5],
      ],
    },
    {
      email: "kitchen.de@brightwave.example",
      name: "Kitchen DE",
      me: "Brightwave Kitchen DE",
      group: "Channels",
      style: "gmail",
      agentAccess: "organize",
      signature: "Team Brightwave Kitchen DE",
      mix: [
        [(c) => content.platformThread(c, "de"), 24],
        [(c) => content.sponsorshipThread(c, "Brightwave Kitchen DE", "de"), 12],
        [(c) => content.sponsorshipThread(c, "Brightwave Kitchen DE", "en"), 8],
        [content.newsletterThread, 8],
        [content.spamThread, 3],
      ],
    },
    {
      email: "travel.ar@brightwave.example",
      name: "Travel AR",
      me: "Brightwave Travel AR",
      group: "Channels",
      style: "gmail",
      agentAccess: "organize",
      signature: "فريق Brightwave",
      mix: [
        [(c) => content.platformThread(c, "en"), 14],
        [content.arabicSponsorshipThread, 20],
        [(c) => content.sponsorshipThread(c, "Brightwave Travel AR", "en"), 6],
        [content.spamThread, 3],
      ],
    },
    {
      email: "shorts@brightwave.example",
      name: "Shorts",
      me: "Brightwave Shorts",
      group: "Channels",
      style: "gmail",
      agentAccess: "read",
      signature: "Brightwave Shorts",
      mix: [
        [(c) => content.platformThread(c, "en"), 15],
        [(c) => content.sponsorshipThread(c, "Brightwave Shorts", "en"), 15],
        [content.newsletterThread, 6],
        [content.spamThread, 2],
      ],
    },
    {
      email: "banking@mail.example",
      name: "Nordbank Business",
      me: "Alex Morgan",
      group: "Banking",
      style: "imap",
      agentAccess: "read",
      signature: "",
      mix: [[(c) => content.bankThread(c, true), 58]],
    },
    {
      email: "private.bank@mail.example",
      name: "Private bank",
      me: "Alex Morgan",
      group: "Banking",
      style: "imap",
      agentAccess: "none",
      signature: "",
      mix: [
        [(c) => content.bankThread(c, false), 22],
        [content.utilityThread, 3],
      ],
    },
    {
      email: "alex.private@mail.example",
      name: "Alex private",
      me: "Alex Morgan",
      group: "Personal",
      style: "gmail",
      agentAccess: "organize",
      signature: "Alex",
      mix: [
        [content.shippingThread, 20],
        [content.travelThread, 8],
        [content.receiptThread, 14],
        [content.newsletterThread, 10],
        [content.utilityThread, 3],
        [content.spamThread, 2],
      ],
    },
    {
      email: "family@mail.example",
      name: "Family",
      me: "أليكس",
      group: "Personal",
      style: "imap",
      agentAccess: "read",
      signature: "أليكس",
      mix: [[(c) => content.familyThread(c), 28]],
    },
    {
      email: "newsletter.dump@mail.example",
      name: "Newsletters",
      me: "Alex",
      group: null,
      style: "imap",
      agentAccess: "organize",
      signature: "",
      mix: [
        [content.newsletterThread, 46],
        [content.spamThread, 8],
      ],
    },
  ];
}

const MAILBOXES: Record<Style, { path: string; name: string; role: MailboxRecord["role"] }[]> = {
  gmail: [
    { path: "INBOX", name: "Inbox", role: "inbox" },
    { path: "[Gmail]/All Mail", name: "All Mail", role: "all" },
    { path: "[Gmail]/Sent Mail", name: "Sent Mail", role: "sent" },
    { path: "[Gmail]/Drafts", name: "Drafts", role: "drafts" },
    { path: "[Gmail]/Spam", name: "Spam", role: "spam" },
    { path: "[Gmail]/Trash", name: "Trash", role: "trash" },
  ],
  imap: [
    { path: "INBOX", name: "Inbox", role: "inbox" },
    { path: "Archive", name: "Archive", role: "archive" },
    { path: "Sent", name: "Sent", role: "sent" },
    { path: "Drafts", name: "Drafts", role: "drafts" },
    { path: "Junk", name: "Junk", role: "spam" },
    { path: "Trash", name: "Trash", role: "trash" },
  ],
};

export interface SeedOptions {
  now?: number;
  seed?: number;
}

export interface SeedSummary {
  accounts: number;
  threads: number;
  messages: number;
  attachments: number;
}

const DEMO_GROUPS_KEY = "demo.groupIds";
const DEMO_LABELS_KEY = "demo.labelIds";

/** Seeds the demo accounts. Labels and groups are reused by name when they exist. */
/** The Gmail category a kind of demo conversation lands in (the rest is Primary). */
const DEMO_CATEGORIES: Record<string, string> = {
  newsletter: "promotions",
  platform: "social",
  shipping: "updates",
  receipt: "updates",
  utility: "updates",
  statement: "updates",
  invite: "forums",
};

export function seedDemo(env: ServiceEnv, options: SeedOptions = {}): SeedSummary {
  const now = options.now ?? env.now();
  const rng = content.createRng(options.seed ?? 20261108);
  const { store } = env;
  const id = (prefix: IdPrefix) => {
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 12; i++) bytes[i] = Math.floor(rng.next() * 256);
    return idFromBytes(prefix, bytes);
  };
  const dir = env.paths.demoAttachments;
  fs.mkdirSync(dir, { recursive: true });

  const summary: SeedSummary = { accounts: 0, threads: 0, messages: 0, attachments: 0 };
  const keyed = new Map<string, { threadId: string; accountId: string; lastMessageId: string }>();
  const byKind = new Map<string, { threadId: string; accountId: string }[]>();

  env.db.tx(() => {
    // Labels and groups (reused by name).
    const labelIds = new Map<string, string>();
    const createdLabels: string[] = [];
    for (const l of DEMO_LABELS) {
      const existing = store.labels.findByName(l.name);
      if (existing) labelIds.set(l.name, existing.id);
      else {
        const labelId = id("lbl");
        store.labels.insert({ id: labelId, name: l.name, color: l.color, sortOrder: store.labels.nextSortOrder(), createdAt: now - SPAN_DAYS * DAY });
        labelIds.set(l.name, labelId);
        createdLabels.push(labelId);
      }
    }
    if (createdLabels.length > 0) store.kv.set(DEMO_LABELS_KEY, JSON.stringify(createdLabels));
    const groupIds = new Map<string, string>();
    const createdGroups: string[] = [];
    for (const g of DEMO_GROUPS) {
      const existing = store.groups.list().find((x) => x.name.toLowerCase() === g.name.toLowerCase());
      if (existing) groupIds.set(g.name, existing.id);
      else {
        const groupId = id("grp");
        store.groups.insert({ id: groupId, name: g.name, color: g.color, sortOrder: store.groups.nextSortOrder(), collapsed: false, createdAt: now - SPAN_DAYS * DAY });
        groupIds.set(g.name, groupId);
        createdGroups.push(groupId);
      }
    }
    if (createdGroups.length > 0) store.kv.set(DEMO_GROUPS_KEY, JSON.stringify(createdGroups));

    const specs = accountsSpec();
    specs.forEach((spec, index) => {
      if (store.accounts.findByEmail(spec.email)) return;
      const accountId = id("acc");
      const groupId = spec.group ? (groupIds.get(spec.group) ?? null) : null;
      store.accounts.insert({
        id: accountId,
        email: spec.email,
        displayName: spec.name,
        username: spec.email,
        provider: "demo",
        authKind: "none",
        groupId,
        color: COLOR_PALETTE[index % COLOR_PALETTE.length]!,
        sortOrder: store.accounts.nextSortOrder(groupId),
        agentAccess: spec.agentAccess,
        signature: spec.signature,
        imap: null,
        smtp: null,
        status: { state: "ready", message: "Demo account", lastSyncAt: now, progress: null },
        paused: false,
        isDemo: true,
        createdAt: now - SPAN_DAYS * DAY + index * 1000,
      });
      summary.accounts++;

      const boxes = new Map<string, MailboxRecord>();
      for (const mb of MAILBOXES[spec.style]) {
        const record: MailboxRecord = {
          id: id("mbx"),
          accountId,
          path: mb.path,
          name: mb.name,
          role: mb.role,
          delimiter: "/",
          specialUse: null,
          uidvalidity: 1,
          uidnext: 1,
          highestmodseq: null,
          sync: null,
          selectable: true,
          createdLocally: false,
        };
        store.mailboxes.insert(record);
        boxes.set(mb.role!, record);
      }
      const extraFolders = new Map<string, MailboxRecord>();
      const folder = (name: string) => {
        let mb = extraFolders.get(name);
        if (!mb) {
          mb = { id: id("mbx"), accountId, path: name, name, role: null, delimiter: "/", specialUse: null, uidvalidity: 1, uidnext: 1, highestmodseq: null, sync: null, selectable: true, createdLocally: false };
          store.mailboxes.insert(mb);
          extraFolders.set(name, mb);
        }
        return mb;
      };
      if (spec.email === "billing@brightwave.example") folder("Rechnungen 2025");
      const uids = new Map<string, number>();
      const nextUid = (mailboxId: string) => {
        const n = (uids.get(mailboxId) ?? 0) + 1;
        uids.set(mailboxId, n);
        return n;
      };

      const me: Address = { name: spec.me, address: spec.email };
      // Plan every conversation's start time first so the newest is today.
      const plans: { gen: (c: Ctx) => DemoThread; at: number }[] = [];
      for (const [gen, count] of spec.mix) {
        for (let i = 0; i < count; i++) {
          const daysAgo = SPAN_DAYS * rng.next() ** 1.7;
          plans.push({ gen, at: now - daysAgo * DAY - rng.int(0, 600) * 60_000 });
        }
      }
      // A few fresh ones today for every account.
      plans.sort((x, y) => y.at - x.at);
      plans.slice(0, 2).forEach((p, i) => (p.at = now - (20 + i * 70 + rng.int(0, 60)) * 60_000));

      // Monthly statements for the banking accounts.
      if (spec.email === "banking@mail.example" || spec.email === "private.bank@mail.example") {
        for (let month = 0; month < 9; month++) {
          const d = new Date(now);
          d.setDate(2);
          d.setMonth(d.getMonth() - month);
          d.setHours(6, 30, 0, 0);
          if (d.getTime() > now) continue;
          const business = spec.email === "banking@mail.example";
          plans.push({ gen: (c) => content.statementThread(c, business, business && month === 1), at: d.getTime() });
        }
      }

      const featured: { gen: (c: Ctx) => DemoThread; at: number; key: string }[] = [];
      if (spec.email === "alex@brightwave.example") {
        featured.push({ gen: (c) => ({ ...content.taxThread(c, 0), place: "inbox", labels: ["Taxes 2026"], unread: true }), at: now - 2 * DAY - 5 * HOUR, key: "tax-ustva" });
      }
      if (spec.email === "billing@brightwave.example") {
        featured.push({ gen: (c) => ({ ...content.invoiceThread(c, content.VENDORS[0]), place: "inbox", labels: [], unread: true }), at: now - 40 * 60_000, key: "invoice-today" });
      }
      if (spec.email === "family@mail.example") {
        featured.push({ gen: (c) => ({ ...content.familyPhotoThread(c), unread: true }), at: now - 3 * HOUR, key: "family-photo" });
      }
      if (spec.email === "studio@brightwave.example") {
        featured.push({ gen: (c) => ({ ...content.newsletterThread(c), place: "inbox", key: "newsletter-today" }), at: now - 90 * 60_000, key: "newsletter-today" });
      }

      // Featured first, so a random conversation never takes the place of a featured one.
      const all = [...featured, ...plans.map((p) => ({ ...p, key: undefined as string | undefined }))];
      // A real mailbox holds one "Collab call next week?" conversation, not three copies of it.
      // Back-and-forth conversations are unique per account; one-off notices (statements,
      // payslips) may repeat their subject like they do in real life.
      const conversationSubjects = new Set<string>();
      for (const plan of all) {
        const age = (now - plan.at) / DAY;
        const ctx: Ctx = { rng, me, at: plan.at, now, age };
        const thread = plan.gen(ctx);
        const conversational = thread.messages.length > 1 || thread.messages.some((m) => m.fromMe);
        const subjectKey = (thread.messages[0]?.subject ?? "").replace(/^((re|aw|fwd?|wg|ر?د)\s*:\s*)+/i, "").trim().toLowerCase();
        if (conversational && subjectKey) {
          if (conversationSubjects.has(subjectKey)) continue;
          conversationSubjects.add(subjectKey);
        }
        if (plan.key) thread.key = plan.key;
        const threadId = id("thr");
        insertThread(thread, threadId);
        const entry = { threadId, accountId };
        const list = byKind.get(thread.kind);
        if (list) list.push(entry);
        else byKind.set(thread.kind, [entry]);
      }

      function insertThread(thread: DemoThread, threadId: string): void {
        const place = thread.place;
        const trashChance = place === "inbox" || place === "archive" ? rng.chance(0.03) : false;
        const finalPlace = trashChance ? "trash" : place;
        const lastReceived = [...thread.messages].reverse().find((m) => !m.fromMe);
        const lastAt = thread.messages.at(-1)!.at;
        const unreadLast =
          thread.unread ??
          (finalPlace === "spam" ? rng.chance(0.5) : (now - lastAt) / DAY < 10 ? rng.chance(0.6) : rng.chance(0.04));
        const starIndex = thread.starred ? thread.messages.length - 1 : -1;
        let previous: { header: string; refs: string[] } | null = null;
        let lastMessageId = "";
        thread.messages.forEach((m, i) => {
          const messageId = id("msg");
          lastMessageId = messageId;
          const domain = m.from.address.split("@")[1] ?? "mail.example";
          const header = `<${messageId.slice(4)}.${i}@${domain}>`;
          const refs = previous ? [...previous.refs, previous.header] : [];
          const text = m.text + (m.fromMe && spec.signature && !m.text.includes(spec.signature) ? `\n\n-- \n${spec.signature}` : "");
          const attachments = m.attachments ?? [];
          const size = Buffer.byteLength(text) + (m.html ? Buffer.byteLength(m.html) : 0) + attachments.reduce((s, x) => s + x.data.length, 0) + 900;
          store.messages.insert({
            id: messageId,
            accountId,
            threadId,
            remoteId: header,
            gmThreadId: null,
            messageIdHeader: header,
            inReplyTo: previous?.header ?? null,
            references: refs,
            subject: m.subject,
            from: m.from,
            to: m.to,
            cc: m.cc ?? [],
            bcc: [],
            replyTo: [],
            date: m.at,
            snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
            size,
            unread: !m.fromMe && m === lastReceived && unreadLast,
            starred: i === starIndex,
            isDraft: false,
            hasAttachments: attachments.some((x) => !x.inline),
            bodyState: "ready",
            createdAt: now,
          });
          // Where it is.
          const locations: { box: MailboxRecord; uid: boolean }[] = [];
          const inbox = boxes.get("inbox")!;
          if (finalPlace === "trash") locations.push({ box: boxes.get("trash")!, uid: true });
          else if (finalPlace === "spam") locations.push({ box: boxes.get("spam")!, uid: true });
          else if (spec.style === "gmail") {
            locations.push({ box: boxes.get("all")!, uid: true });
            if (m.fromMe) locations.push({ box: boxes.get("sent")!, uid: false });
            else if (finalPlace === "inbox") locations.push({ box: inbox, uid: false });
          } else if (m.fromMe) locations.push({ box: boxes.get("sent")!, uid: true });
          else if (finalPlace === "inbox") locations.push({ box: inbox, uid: true });
          else if (thread.folder) locations.push({ box: folder(thread.folder), uid: true });
          else if (spec.email === "billing@brightwave.example" && thread.kind === "invoice" && (now - m.at) / DAY > 200) {
            locations.push({ box: folder("Rechnungen 2025"), uid: true });
          } else locations.push({ box: boxes.get("archive") ?? inbox, uid: true });
          for (const loc of locations) store.messages.addLocation(messageId, loc.box.id, loc.uid ? nextUid(loc.box.id) : null);
          // Gmail sorts its inbox into categories (the inbox tabs).
          if (spec.style === "gmail" && !m.fromMe && finalPlace === "inbox") {
            env.db.run("UPDATE messages SET category = ? WHERE id = ?", DEMO_CATEGORIES[thread.kind] ?? "primary", messageId);
          }
          if (finalPlace === "trash" || finalPlace === "spam") {
            const back = spec.style === "gmail" ? [boxes.get("all")!.id, ...(m.fromMe ? [] : [inbox.id])] : [m.fromMe ? boxes.get("sent")!.id : inbox.id];
            store.messages.update(messageId, { restoreTo: back });
          }
          for (const name of thread.labels) {
            const labelId = labelIds.get(name);
            if (labelId) store.messages.addLabel(messageId, labelId);
          }
          attachments.forEach((att, index) => {
            const attId = id("att");
            const file = path.join(dir, `${attId}-${safeFilename(att.filename)}`);
            fs.writeFileSync(file, att.data);
            store.messages.insertAttachment({
              id: attId,
              messageId,
              part: String(index + 2),
              filename: att.filename,
              mimeType: att.mimeType,
              size: att.data.length,
              contentId: att.contentId ?? null,
              inline: att.inline ?? false,
              localPath: file,
              sortOrder: index,
            });
            summary.attachments++;
          });
          store.messages.setBody(messageId, { text, html: m.html ?? null }, m.at);
          summary.messages++;
          previous = { header, refs };
        });
        store.refreshThreads([threadId]);
        summary.threads++;
        if (thread.key) keyed.set(thread.key, { threadId, accountId, lastMessageId });
      }
    });

    seedDrafts(env, { now, id, keyed });
  });

  seedActivity(env, { now, rng, byKind });
  return summary;
}

function seedDrafts(
  env: ServiceEnv,
  input: { now: number; id: (prefix: IdPrefix) => string; keyed: Map<string, { threadId: string; accountId: string; lastMessageId: string }> },
): void {
  const { store } = env;
  const studio = store.accounts.findByEmail("studio@brightwave.example");
  if (studio) {
    const threadId = input.id("thr");
    store.threads.insertPlaceholder(threadId, studio.id, input.now - 50 * 60_000);
    store.drafts.upsert({
      id: input.id("drf"),
      accountId: studio.id,
      mode: "new",
      threadId,
      sourceMessageId: null,
      to: [{ name: "Kreator Network Partnerships", address: "partnerships@kreator-network.example" }],
      cc: [],
      bcc: [],
      subject: "Collab proposal: Winter recipe special",
      bodyText:
        "Hi Lena,\n\nfollowing up on our call: here's the rough plan for the winter recipe special.\n\n- 3 channels, one shared episode (DE, AR, Shorts cut)\n- release window: first week of December\n- ",
      attachments: [],
      createdBy: { kind: "user" },
      createdAt: input.now - 50 * 60_000,
      updatedAt: input.now - 50 * 60_000,
      sendState: "draft",
      sendError: null,
      remoteUid: null,
      remoteMailboxId: null,
    });
    store.refreshThreads([threadId]);
  }
  const tax = input.keyed.get("tax-ustva");
  if (tax) {
    const last = store.messages.get(tax.lastMessageId);
    const agent: Actor = { kind: "agent", name: "claude-code" };
    const draftId = input.id("drf");
    store.drafts.upsert({
      id: draftId,
      accountId: tax.accountId,
      mode: "reply",
      threadId: tax.threadId,
      sourceMessageId: tax.lastMessageId,
      to: last?.from ? [last.from] : [],
      cc: [],
      bcc: [],
      subject: last ? `AW: ${last.subject.replace(/^(AW|Re):\s*/i, "")}` : "AW: USt-VA",
      bodyText:
        "Hallo Frau Weber,\n\nanbei die fehlenden Belege für die Umsatzsteuer-Voranmeldung:\n\n- CloudKiln, Rechnung RE-2026 (Render-Cluster)\n- VoiceForge AI, zwei Rechnungen\n- PayFlow-Zahlungen an Pixelmarkt als PDF-Export\n\nSagen Sie gern Bescheid, falls noch etwas fehlt.\n\nViele Grüße\nAlex Morgan",
      attachments: [],
      createdBy: agent,
      createdAt: input.now - 4 * HOUR,
      updatedAt: input.now - 4 * HOUR,
      sendState: "draft",
      sendError: null,
      remoteUid: null,
      remoteMailboxId: null,
    });
    store.refreshThreads([tax.threadId]);
    // The summary Claude Code wrote above the conversation (after its latest message).
    store.summaries.set(tax.threadId, {
      text:
        "Weber & Partner need three receipts for the VAT return; the deadline is the **10th**.\n\n- Missing: **CloudKiln** (render cluster), **VoiceForge AI** (two invoices), the **PayFlow** payments to Pixelmarkt\n- A PayFlow PDF export is fine if the date and recipient show\n- A reply with the list is drafted below: attach the files and send it",
      by: agent,
      at: Math.max(input.now - 4 * HOUR, (store.threads.get(tax.threadId)?.last_message_at ?? 0) + 60_000),
    });
    writeActivity(env, {
      actor: agent,
      summary: `Drafted a reply to “${last ? last.subject.replace(/^(AW|Re):\s*/i, "") : "USt-VA"}”`,
      kind: "draft",
      threadIds: [tax.threadId],
      accountIds: [tax.accountId],
      undo: { type: "draftCreate", draftId },
      at: input.now - 4 * HOUR,
      isDemo: true,
    });
  }
}

/** Past changes in Activity: two by Claude Code (undoable), one by the user, one already undone. */
function seedActivity(env: ServiceEnv, input: { now: number; rng: Rng; byKind: Map<string, { threadId: string; accountId: string }[]> }): void {
  const { store } = env;
  const mutateEnv = { store, now: () => input.now };
  const inInbox = (ids: string[]) => ids.filter((tid) => store.threads.get(tid)?.in_inbox === 1);
  const labelId = (name: string) => store.labels.findByName(name)?.id;

  const record = (actor: Actor, at: number, threadIds: string[], actions: ModifyAction[], summary?: string, undone = false) => {
    if (threadIds.length === 0) return;
    const change = applyChange(
      env,
      actions.map((action) => ({ action: action.type, plan: () => planAction(mutateEnv, threadIds, action).deltas })),
      { publish: false },
    );
    if (change.threadIds.length === 0) return;
    const labelName = (lid: string) => store.labels.get(lid)?.name ?? "a label";
    const activity = writeActivity(env, {
      actor,
      summary: summary ?? summarize(actions, change.threadIds.length, labelName),
      kind: "modify",
      threadIds: change.threadIds,
      accountIds: change.accountIds,
      undo: { type: "modify", steps: change.undoSteps },
      at,
      isDemo: true,
    });
    if (undone) {
      applyChange(env, change.undoSteps.map((s) => ({ action: `undo:${s.action}`, plan: () => s.deltas })), { publish: false });
      store.activity.markUndone(activity.id, at + 5 * 60_000, { kind: "user" });
    }
  };

  const agent: Actor = { kind: "agent", name: "claude-code" };
  const invoicesId = labelId("Invoices");
  if (invoicesId) {
    const unlabeled = (input.byKind.get("invoice") ?? [])
      .map((t) => t.threadId)
      .filter((tid) => !(store.threads.labelIds([tid]).get(tid) ?? []).includes(invoicesId));
    record(agent, input.now - 3 * HOUR, unlabeled.slice(0, 18), [{ type: "addLabels", labelIds: [invoicesId] }]);
  }
  const newsletters = inInbox((input.byKind.get("newsletter") ?? []).map((t) => t.threadId)).filter((tid) => {
    const row = store.threads.get(tid);
    return row !== null && input.now - row.last_message_at > 2 * DAY;
  });
  const archived = newsletters.slice(-42);
  record(agent, input.now - 2 * HOUR, archived, [{ type: "archive" }], `Archived ${archived.length} newsletters`);

  const partner = inInbox([...(input.byKind.get("partner") ?? []), ...(input.byKind.get("sponsorship") ?? [])].map((t) => t.threadId))
    .filter((tid) => store.threads.get(tid)?.starred === 0)
    .slice(0, 2);
  record({ kind: "user" }, input.now - 26 * HOUR, partner, [{ type: "star" }]);

  const unread = (kind: string) =>
    inInbox((input.byKind.get(kind) ?? []).map((t) => t.threadId)).filter((tid) => (store.threads.get(tid)?.unread_count ?? 0) > 0);
  const toRead = [...unread("bank"), ...unread("shipping"), ...unread("platform")].slice(0, 5);
  record({ kind: "user" }, input.now - 2 * DAY, toRead, [{ type: "markRead" }], undefined, true);

  // Done with: most read inbox mail older than a few days is settled (the Settled section).
  const all = [...new Set([...input.byKind.values()].flat().map((t) => t.threadId))];
  const done = inInbox(all).filter((tid) => {
    const row = store.threads.get(tid);
    return row !== null && row.unread_count === 0 && row.starred === 0 && row.draft_count === 0 && input.now - row.last_message_at > 3 * DAY;
  });
  if (done.length > 0) {
    ensureStateLabel(store, "settled", input.now - 3 * DAY);
    record({ kind: "user" }, input.now - DAY, done.filter((_, i) => i % 5 !== 0), [{ type: "settle" }]);
  }

  // The other states, a few each: a partner thread pinned, answers waited for (one ran out,
  // one came), and something snoozed.
  const open = inInbox(all).filter((tid) => !(store.threads.labelIds([tid]).get(tid) ?? []).length);
  const pick = (n: number, ok: (row: NonNullable<ReturnType<typeof store.threads.get>>) => boolean) => {
    const out: string[] = [];
    for (const tid of open) {
      const row = store.threads.get(tid);
      if (out.length < n && row && ok(row) && !used.has(tid)) {
        out.push(tid);
        used.add(tid);
      }
    }
    return out;
  };
  const used = new Set<string>();
  const pinned = pick(1, (r) => r.starred === 1);
  const waiting = pick(2, (r) => r.unread_count === 0 && r.message_count > 1);
  const snoozed = pick(1, (r) => r.unread_count === 0);
  const noReply = pick(1, (r) => r.unread_count === 0 && r.message_count > 1);
  const replied = pick(1, (r) => r.unread_count > 0 && r.message_count > 1);
  for (const key of ["pinned", "waiting", "snoozed"] as const) ensureStateLabel(store, key, input.now - 3 * DAY);
  record({ kind: "user" }, input.now - 5 * HOUR, pinned, [{ type: "pin" }]);
  waiting.forEach((tid, i) => {
    const until = input.now + (i === 0 ? 5 : 12) * DAY;
    record({ kind: "user" }, input.now - (i + 2) * DAY, [tid], [{ type: "wait", until }]);
    store.threadStates.setTimer({ threadId: tid, kind: "waiting", until, setAt: input.now - (i + 2) * DAY });
  });
  for (const tid of snoozed) {
    const until = input.now + 2 * DAY;
    record({ kind: "user" }, input.now - 6 * HOUR, [tid], [{ type: "snooze", until }]);
    store.threadStates.setTimer({ threadId: tid, kind: "snoozed", until, setAt: input.now - 6 * HOUR });
  }
  for (const tid of noReply) store.threadStates.setMark({ threadId: tid, kind: "noReply", at: input.now - 3 * HOUR });
  for (const tid of replied) store.threadStates.setMark({ threadId: tid, kind: "replied", at: input.now - 2 * HOUR });
}

/** Deletes every demo account with its mail, files and activity. Labels stay. */
export function removeDemo(env: ServiceEnv): string[] {
  const { store } = env;
  const ids = store.accounts.demoIds();
  env.db.tx(() => {
    for (const accountId of ids) store.accounts.delete(accountId);
    store.activity.deleteDemo();
    const groups = JSON.parse(store.kv.get(DEMO_GROUPS_KEY) ?? "[]") as string[];
    for (const groupId of groups) {
      if (store.groups.get(groupId) && store.groups.accountIds(groupId).length === 0) store.groups.delete(groupId);
    }
    store.kv.delete(DEMO_GROUPS_KEY);
    // The labels the demo made, unless some remaining mail carries them. Demo data from before
    // the ids were kept: the demo's label names.
    const kept = store.kv.get(DEMO_LABELS_KEY);
    const labels = kept
      ? (JSON.parse(kept) as string[])
      : DEMO_LABELS.map((l) => store.labels.findByName(l.name)?.id).filter((x): x is string => !!x);
    // Fancy Mail's own labels too, when only demo mail carried them (they come back when used).
    for (const key of ["settled", "waiting", "snoozed", "pinned"] as const) {
      const label = findStateLabel(store.labels.list(), key);
      if (label) labels.push(label.id);
    }
    const deleted = findDeletedLabel(store.labels.list());
    if (deleted) labels.push(deleted.id);
    for (const labelId of labels) {
      if (store.labels.get(labelId) && store.labels.messagesWithLabel(labelId).length === 0) store.labels.delete(labelId);
    }
    store.kv.delete(DEMO_LABELS_KEY);
  });
  try {
    fs.rmSync(env.paths.demoAttachments, { recursive: true, force: true });
  } catch (error) {
    env.log.warn("could not delete the demo attachments", { error });
  }
  return ids;
}
