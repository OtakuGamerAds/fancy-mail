/**
 * A stand-in for apps/server while it is being built: the same /ws protocol and /api routes,
 * with made-up mail in memory. For looking at the web client only; nothing is stored.
 *
 *   node --experimental-strip-types apps/web/scripts/mock-server.mjs   (port 47822)
 */
import { createRequire } from "node:module";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseQuery } from "../../../packages/contracts/src/query.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../server/package.json"));
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.FANCY_MAIL_SERVER_PORT ?? 47822);
const now = Date.now();
const H = 3_600_000;
const D = 24 * H;

let seq = 1;
const id = (p) => `${p}_${(seq++).toString(36)}`;

// ── Seed ────────────────────────────────────────────────────────────────────────────────────

const groups = [
  { id: "g_bank", name: "Banking", color: "#10b981", sortOrder: 0, collapsed: false },
  { id: "g_chan", name: "Channels", color: "#8b5cf6", sortOrder: 1, collapsed: false },
  { id: "g_biz", name: "Business", color: "#3b82f6", sortOrder: 2, collapsed: false },
  { id: "g_pers", name: "Personal", color: "#f59e0b", sortOrder: 3, collapsed: true },
];

const status = (state, message = null) => ({ state, message, lastSyncAt: now - 5 * 60_000, progress: state === "syncing" ? { done: 1240, total: 3800 } : null });
const accounts = [
  { id: "a_billing", email: "billing@brightwave.example", displayName: "Billing", senderName: "Billing", provider: "gmail", groupId: "g_bank", color: "#10b981", status: status("ready") },
  { id: "a_bank2", email: "konto@sparkasse-mail.example", displayName: "Sparkasse", senderName: "Sparkasse", provider: "imap", groupId: "g_bank", color: "#14b8a6", status: status("auth-required") },
  { id: "a_yt", email: "brightwave.yt@mail.example", displayName: "YouTube channel", senderName: "YouTube channel", provider: "gmail", groupId: "g_chan", color: "#ef4444", status: status("syncing") },
  { id: "a_twitch", email: "streams@brightwave.example", displayName: "Twitch", senderName: "Twitch", provider: "gmail", groupId: "g_chan", color: "#d946ef", status: status("ready") },
  { id: "a_ads", email: "ads@brightwave.example", displayName: "Brightwave Ads", senderName: "Brightwave Ads", provider: "gmail", groupId: "g_biz", color: "#3b82f6", status: status("ready") },
  { id: "a_support", email: "support@brightwave.example", displayName: "Support", senderName: "Support", provider: "imap", groupId: "g_biz", color: "#06b6d4", status: status("offline", "Can't reach imap.brightwave.example. Retrying by itself.") },
  { id: "a_me", email: "alex@mail.example", displayName: "Alex", senderName: "Alex", provider: "gmail", groupId: "g_pers", color: "#f97316", status: status("ready") },
  { id: "a_old", email: "old.address@gmx.example", displayName: "Old GMX", senderName: "Old GMX", provider: "imap", groupId: null, color: "#64748b", status: status("paused") },
].map((a, i) => ({
  authKind: a.provider === "gmail" ? "password" : "password",
  sortOrder: i,
  agentAccess: i % 3 === 0 ? "draft" : i % 3 === 1 ? "organize" : "read",
  signature: i === 4 ? "Brightwave Ads\nhttps://brightwave.example" : "",
  imap: { host: "imap.example", port: 993, secure: true },
  smtp: { host: "smtp.example", port: 465, secure: true },
  createdAt: now - 90 * D,
  ...a,
}));

const labels = [
  { id: "l_inv", name: "Invoices", color: "#10b981", sortOrder: 0 },
  { id: "l_rec", name: "Receipts", color: "#06b6d4", sortOrder: 1 },
  { id: "l_news", name: "Newsletters", color: "#8b5cf6", sortOrder: 2 },
  { id: "l_travel", name: "Travel", color: "#f97316", sortOrder: 3 },
  { id: "l_spons", name: "Sponsorships", color: "#ec4899", sortOrder: 4 },
  { id: "l_tax", name: "Tax 2026", color: null, sortOrder: 5 },
];

const mailboxes = [
  ...accounts.flatMap((a) => [
    { id: `mb_${a.id}_inbox`, accountId: a.id, path: "INBOX", name: "Inbox", role: "inbox", unreadCount: 0, totalCount: 0 },
    { id: `mb_${a.id}_sent`, accountId: a.id, path: "Sent", name: "Sent", role: "sent", unreadCount: 0, totalCount: 0 },
  ]),
  { id: "mb_ads_rech", accountId: "a_ads", path: "Rechnungen", name: "Rechnungen", role: null, unreadCount: 2, totalCount: 40 },
  { id: "mb_ads_kunden", accountId: "a_ads", path: "Kunden/2026", name: "Kunden/2026", role: null, unreadCount: 0, totalCount: 12 },
];

const people = [
  { name: "Anna Weber", address: "anna.weber@weber-design.example" },
  { name: "Ben Hoffmann", address: "ben@hoffmann-studio.example" },
  { name: "PayPal", address: "service@paypal.example" },
  { name: "YouTube", address: "no-reply@youtube.example" },
  { name: "Stripe", address: "receipts@stripe.example" },
  { name: "Deutsche Bahn", address: "buchungsbestaetigung@bahn.example" },
  { name: "سارة أحمد", address: "sara.ahmed@mail.example" },
  { name: "Lena Fischer", address: "lena@brandpartners.example" },
  { name: "GitHub", address: "noreply@github.example" },
  { name: "Finanzamt", address: "elster@finanzamt.example" },
  { name: "Marco Rossi", address: "marco@rossi-media.example" },
  { name: "The Verge", address: "newsletter@theverge.example" },
];

const subjects = [
  ["Rechnung November 2026", "Ihre Rechnung Nr. 2026-1142 über 249,00 € ist beigefügt.", ["l_inv"]],
  ["Your receipt from Stripe #1873-2201", "Amount paid €49.00 · Nov 6, 2026 · Visa •••• 4242", ["l_rec"]],
  ["Sponsorship proposal for December", "Hi! We loved your last video and would like to talk about a sponsored segment.", ["l_spons"]],
  ["Ihre Reise nach Berlin", "Buchungsbestätigung ICE 593 · Abfahrt 08:12 · Wagen 7, Platz 42", ["l_travel"]],
  ["Re: Thumbnail drafts", "These look great — can we try the blue one with a bigger title?", []],
  ["Your channel hit 100K subscribers 🎉", "Congratulations! Here's how to request your Silver Creator Award.", []],
  ["موعد الاجتماع يوم الخميس", "مرحبا، هل يناسبك الاجتماع يوم الخميس الساعة الثالثة؟", []],
  ["Weekly digest: what's new in tech", "Apple's new chips, the state of AI agents, and a deep dive into email.", ["l_news"]],
  ["[GitHub] A new SSH key was added", "The following SSH key was added to your account.", []],
  ["Steuerbescheid 2025", "Ihr Steuerbescheid steht zum Abruf bereit.", ["l_tax"]],
  ["Contract for the Q1 campaign", "Attached is the contract. Please sign and send it back by Friday.", ["l_spons"]],
  ["Payment received", "You've received €320.00 from Rossi Media.", ["l_rec", "l_inv"]],
];

const threads = [];
const messages = new Map();

function htmlBody(subject, snippet, from) {
  return `<!doctype html><html><head><style>.btn{background:#1a73e8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block}</style></head><body>
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif"><tr><td style="padding:8px 0">
<img src="https://cdn.example.com/logo.png" width="120" alt="${from.name}" style="display:block;margin-bottom:16px">
<h2 style="margin:0 0 12px;color:#202124">${subject}</h2>
<p style="color:#3c4043;line-height:1.6">${snippet}</p>
<p style="color:#3c4043;line-height:1.6">If you have questions, just reply to this email or visit <a href="https://example.com/help">our help center</a>.</p>
<p><a class="btn" href="https://example.com/view">View details</a></p>
<p style="color:#80868b;font-size:12px;margin-top:24px">You received this email because you have an account with ${from.name}. <a href="https://example.com/unsubscribe" style="color:#80868b">Unsubscribe</a></p>
</td></tr></table></body></html>`;
}

for (let i = 0; i < 420; i++) {
  const account = accounts[i % accounts.length];
  const [subject, snippet, labelIds] = subjects[i % subjects.length];
  const from = people[(i * 7) % people.length];
  const count = i % 5 === 0 ? 4 + (i % 4) : i % 3 === 0 ? 2 : 1;
  const last = now - i * 2.7 * H - (i % 7) * 13 * 60_000;
  const threadId = `t_${i}`;
  const unread = i < 40 ? i % 3 !== 2 : i % 11 === 0;
  const msgs = [];
  for (let m = 0; m < count; m++) {
    const sender = m % 2 === 1 ? { name: account.displayName, address: account.email } : from;
    const isHtml = (i + m) % 3 === 0 && !/[\u0600-\u06FF]/.test(subject);
    const text =
      m === 0
        ? `${snippet}\n\nBest regards,\n${sender.name}`
        : `${m % 2 ? "Thanks, that works for me." : "Sounds good. One more thing: could you send the final version by tomorrow? www.example.com/files has the brief."}\n\nOn ${new Date(last - (count - m) * H).toDateString()} ${from.name} <${from.address}> wrote:\n> ${snippet}\n> \n> Best regards`;
    msgs.push({
      id: `${threadId}_m${m}`,
      threadId,
      accountId: account.id,
      messageIdHeader: `<${threadId}.${m}@example>`,
      inReplyTo: null,
      references: [],
      from: sender,
      to: [m % 2 === 1 ? from : { name: account.displayName, address: account.email }],
      cc: m === 1 && count > 2 ? [people[(i + 3) % people.length]] : [],
      bcc: [],
      replyTo: [],
      subject: m === 0 ? subject : `Re: ${subject}`,
      date: last - (count - 1 - m) * 5 * H,
      snippet: text.split("\n")[0].slice(0, 140),
      unread: unread && m === count - 1,
      starred: i % 13 === 0 && m === count - 1,
      isDraft: false,
      labelIds,
      attachments:
        i % 4 === 0 && m === 0
          ? [
              { id: `att_${i}_1`, messageId: `${threadId}_m${m}`, filename: `Rechnung-2026-${1000 + i}.pdf`, mimeType: "application/pdf", size: 184_320 + i * 100, contentId: null, inline: false, downloaded: true },
              ...(i % 8 === 0 ? [{ id: `att_${i}_2`, messageId: `${threadId}_m${m}`, filename: "thumbnail-v3.png", mimeType: "image/png", size: 1_284_000, contentId: null, inline: false, downloaded: false }] : []),
            ]
          : [],
      body: i === 1 ? null : isHtml ? { text: null, html: htmlBody(subject, snippet, from) } : { text, html: null },
    });
  }
  msgs.forEach((m) => messages.set(m.id, m));
  threads.push({
    id: threadId,
    accountId: account.id,
    subject,
    snippet: msgs[msgs.length - 1].snippet,
    participants: [...new Map(msgs.map((m) => [m.from.address, m.from])).values()],
    lastMessageAt: last,
    messageCount: count,
    unreadCount: msgs.filter((m) => m.unread).length,
    starred: msgs.some((m) => m.starred),
    hasAttachments: msgs.some((m) => m.attachments.length > 0),
    labelIds,
    inInbox: i % 9 !== 4,
    inSent: count > 1,
    inTrash: i % 37 === 36,
    inSpam: i % 53 === 52,
    draftCount: 0,
    // Gmail's categories, for the inbox tabs.
    category: account.provider !== "gmail" ? null : i % 5 === 1 ? "promotions" : i % 7 === 2 ? "social" : i % 11 === 3 ? "forums" : i % 13 === 4 ? "updates" : "primary",
  });
}

const drafts = [
  {
    id: "d_1",
    accountId: "a_ads",
    mode: "reply",
    threadId: "t_2",
    conversationId: "t_2",
    sourceMessageId: "t_2_m0",
    to: [people[(2 * 7) % people.length]],
    cc: [],
    bcc: [],
    subject: "Re: Sponsorship proposal for December",
    bodyText: "Hi Lena,\n\nThanks for reaching out! December works well for us. Our rate for a 60–90 second integrated segment is €2,400, and we can deliver a draft cut by the 12th.\n\nWould a short call on Tuesday work to go over the details?\n\nBest,\nAlex",
    attachments: [],
    createdBy: { kind: "agent", name: "claude-code" },
    updatedAt: now - 25 * 60_000,
    sendState: "draft",
    sendError: null,
  },
];
threads.find((t) => t.id === "t_2").draftCount = 1;

const activity = [
  { id: id("act"), at: now - 20 * 60_000, actor: { kind: "agent", name: "claude-code" }, summary: "Labeled 12 conversations Invoices", kind: "label", threadIds: ["t_0", "t_12", "t_24"], undoable: true, undoneAt: null },
  { id: id("act"), at: now - 25 * 60_000, actor: { kind: "agent", name: "claude-code" }, summary: "Drafted a reply to Lena Fischer", kind: "draft", threadIds: ["t_2"], undoable: true, undoneAt: null },
  { id: id("act"), at: now - 2 * H, actor: { kind: "user" }, summary: "Archived 3 conversations", kind: "archive", threadIds: ["t_4", "t_5", "t_6"], undoable: true, undoneAt: null },
  { id: id("act"), at: now - 5 * H, actor: { kind: "sync" }, summary: "Synced 48 new messages", kind: "sync", threadIds: [], undoable: false, undoneAt: null },
  { id: id("act"), at: now - 26 * H, actor: { kind: "agent", name: "t3code" }, summary: "Archived 40 newsletters", kind: "archive", threadIds: ["t_7"], undoable: true, undoneAt: now - 25 * H },
];

/** Sends waiting out their Undo time: draftId → { timer, go }. */
const sendWaits = new Map();

let settings = {
  readingPane: "right",
  density: "comfortable",
  remoteImages: "ask",
  allowedImageSenders: [],
  closeToTray: true,
  notifications: false,
  undoSendSeconds: 15,
  inboxTabs: ["promotions", "social", "forums"],
  defaultAgentAccess: "draft",
  mcp: { enabled: true, port: 47821 },
  oauth: { googleClientId: "", googleClientSecret: "", microsoftClientId: "" },
  sync: { initialDays: 365, bodyPrefetchCount: 300 },
};
let mcpToken = "fm_9c1d2e7a54b04f7f8a0b6d3e2c1f9a8b";
const mcpClients = [{ sessionId: "s1", name: "claude-code", version: "2.1.0", connectedAt: now - 42 * 60_000, lastSeenAt: now }];
let hasDemoData = true;

// ── Derived ─────────────────────────────────────────────────────────────────────────────────

function liveThreads() {
  return threads;
}

function bootstrap() {
  const inboxUnread = (accountId) => threads.filter((t) => t.accountId === accountId && t.inInbox && !t.inTrash && !t.inSpam && t.unreadCount > 0).length;
  const accs = accounts.map((a) => ({ ...a, unreadInboxCount: inboxUnread(a.id) }));
  return {
    version: "0.1.0-mock",
    dataDir: "F:\\mock\\.dev-data",
    accounts: accs,
    groups: groups.map((g) => ({ ...g, unreadInboxCount: accs.filter((a) => a.groupId === g.id).reduce((s, a) => s + a.unreadInboxCount, 0) })),
    labels: labels.map((l) => ({
      ...l,
      threadCount: threads.filter((t) => t.labelIds.includes(l.id)).length,
      unreadThreadCount: threads.filter((t) => t.labelIds.includes(l.id) && t.unreadCount > 0 && !t.inTrash).length,
    })),
    mailboxes,
    settings,
    mcp: { enabled: settings.mcp.enabled, url: `http://127.0.0.1:${settings.mcp.port}/mcp`, token: mcpToken, clients: settings.mcp.enabled ? mcpClients : [] },
    hasDemoData,
  };
}

function matches(t, allTerms) {
  // Repeated thread: terms mean "any of these".
  const threadTerms = allTerms.filter((x) => x.kind === "thread" && !x.negated);
  if (threadTerms.length > 0 && !threadTerms.some((x) => x.value === t.id)) return false;
  const terms = allTerms.filter((x) => !(x.kind === "thread" && !x.negated));
  const account = accounts.find((a) => a.id === t.accountId);
  const hasLocation = terms.some((x) => x.kind === "in" && !x.negated);
  if (!hasLocation && (t.inTrash || t.inSpam)) return false;
  for (const term of terms) {
    let ok = true;
    switch (term.kind) {
      case "in":
        ok =
          term.value === "inbox" ? t.inInbox && !t.inTrash && !t.inSpam
          : term.value === "trash" ? t.inTrash
          : term.value === "spam" ? t.inSpam
          : term.value === "sent" ? t.inSent
          : term.value === "archive" ? !t.inInbox && !t.inTrash && !t.inSpam
          : term.value === "starred" ? t.starred
          : term.value === "drafts" ? t.draftCount > 0
          : term.value === "all" ? !t.inTrash && !t.inSpam
          : true;
        break;
      case "is":
        ok = term.value === "unread" ? t.unreadCount > 0 : term.value === "read" ? t.unreadCount === 0 : term.value === "starred" ? t.starred : term.value === "unstarred" ? !t.starred : t.draftCount > 0;
        break;
      case "has":
        ok = t.hasAttachments;
        break;
      case "category":
        ok = term.value === "primary" ? t.category === null || t.category === "primary" : t.category === term.value;
        break;
      case "label": {
        const l = labels.find((x) => x.id === term.value || x.name.toLowerCase() === term.value.toLowerCase());
        ok = term.value === "none" ? t.labelIds.length === 0 : !!l && t.labelIds.includes(l.id);
        break;
      }
      case "account":
        ok = t.accountId === term.value || account.email === term.value;
        break;
      case "group":
        ok = term.value === "none" ? !account.groupId : account.groupId === term.value || groups.find((g) => g.id === account.groupId)?.name.toLowerCase() === term.value.toLowerCase();
        break;
      case "thread":
        ok = t.id === term.value;
        break;
      case "mailbox":
        ok = term.value === "INBOX" ? t.inInbox : (t.id.charCodeAt(t.id.length - 1) % 5) === 0;
        break;
      case "field":
      case "text": {
        const hay = `${t.subject} ${t.snippet} ${t.participants.map((p) => `${p.name} ${p.address}`).join(" ")}`.toLowerCase();
        ok = hay.includes(term.value.toLowerCase());
        break;
      }
      case "date":
        ok = term.op === "before" ? t.lastMessageAt < term.at : t.lastMessageAt >= term.at;
        break;
      default:
        ok = true;
    }
    if ("negated" in term && term.negated) ok = !ok;
    if (!ok) return false;
  }
  return true;
}

function search({ query, cursor, limit = 50 }) {
  const parsed = parseQuery(query);
  const all = liveThreads().filter((t) => matches(t, parsed.terms)).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  const start = cursor ? Number(cursor) : 0;
  const page = all.slice(start, start + limit);
  return { threads: page, nextCursor: start + limit < all.length ? String(start + limit) : null, total: all.length, queryErrors: parsed.errors };
}

// ── Changes ─────────────────────────────────────────────────────────────────────────────────

function applyAction(t, action) {
  const msgs = [...messages.values()].filter((m) => m.threadId === t.id);
  switch (action.type) {
    case "markRead": msgs.forEach((m) => (m.unread = false)); t.unreadCount = 0; break;
    case "markUnread": if (msgs.length) msgs[msgs.length - 1].unread = true; t.unreadCount = Math.max(1, t.unreadCount); break;
    case "star": t.starred = true; break;
    case "unstar": t.starred = false; break;
    case "archive": t.inInbox = false; break;
    case "moveToInbox": t.inInbox = true; t.inTrash = false; t.inSpam = false; break;
    case "trash": t.inTrash = true; t.inInbox = false; break;
    case "restore": t.inTrash = false; t.inInbox = true; break;
    case "markSpam": t.inSpam = true; t.inInbox = false; break;
    case "notSpam": t.inSpam = false; t.inInbox = true; break;
    case "addLabels": t.labelIds = [...new Set([...t.labelIds, ...action.labelIds])]; break;
    case "removeLabels": t.labelIds = t.labelIds.filter((l) => !action.labelIds.includes(l)); break;
  }
}

const SUMMARY = {
  markRead: "Marked {n} read", markUnread: "Marked {n} unread", star: "Starred {n}", unstar: "Unstarred {n}",
  archive: "Archived {n}", moveToInbox: "Moved {n} to the inbox", trash: "Moved {n} to the trash", restore: "Restored {n}",
  markSpam: "Marked {n} as spam", notSpam: "Marked {n} as not spam", addLabels: "Labeled {n} {label}", removeLabels: "Removed {label} from {n}",
};

const snapshots = new Map();

function modify({ threadIds, actions }, actor = { kind: "user" }) {
  const before = threadIds.map((tid) => JSON.parse(JSON.stringify(threads.find((t) => t.id === tid))));
  for (const tid of threadIds) {
    const t = threads.find((x) => x.id === tid);
    if (t) actions.forEach((a) => applyAction(t, a));
  }
  const action = actions[0];
  const n = threadIds.length === 1 ? "1 conversation" : `${threadIds.length} conversations`;
  const labelName = action.labelIds ? labels.find((l) => l.id === action.labelIds[0])?.name ?? "" : "";
  const quiet = action.type === "markRead" && threadIds.length === 1;
  const act = { id: id("act"), at: Date.now(), actor, summary: SUMMARY[action.type].replace("{n}", n).replace("{label}", labelName), kind: action.type, threadIds, undoable: true, undoneAt: null };
  snapshots.set(act.id, before);
  activity.unshift(act);
  broadcast({ type: "invalidate", topics: ["threads", "activity"], threadIds });
  if (!quiet) broadcast({ type: "activity", activity: act });
  return { activity: act };
}

// ── RPC ─────────────────────────────────────────────────────────────────────────────────────

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const handlers = {
  "app.bootstrap": () => bootstrap(),
  "threads.search": (p) => search(p),
  "threads.facets": ({ query }) => {
    const parsed = parseQuery(query);
    const byAccount = {};
    const byLabel = {};
    let total = 0;
    for (const t of liveThreads().filter((x) => matches(x, parsed.terms))) {
      total++;
      byAccount[t.accountId] = (byAccount[t.accountId] ?? 0) + 1;
      for (const l of t.labelIds) byLabel[l] = (byLabel[l] ?? 0) + 1;
    }
    return { total, byAccount, byLabel, queryErrors: parsed.errors };
  },
  "threads.get": ({ threadId }) => {
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new RpcError("not_found", "That conversation isn't here anymore.");
    const msgs = [...messages.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.date - b.date);
    // A body that is "not downloaded yet" arrives a moment later.
    const missing = msgs.find((m) => m.body === null);
    if (missing) setTimeout(() => {
      missing.body = { text: "This body was fetched from the server just now.\n\nIt shows how the reader fills in after an invalidate.", html: null };
      broadcast({ type: "invalidate", topics: ["threads"], threadIds: [threadId] });
    }, 1500);
    return { thread, messages: msgs, drafts: drafts.filter((d) => d.threadId === threadId && d.sendState !== "sent") };
  },
  "threads.modify": (p) => modify(p),
  "threads.fetchBodies": () => ({}),
  "labels.create": ({ name, color }) => {
    const l = { id: id("l"), name, color: color ?? null, sortOrder: labels.length };
    labels.push(l);
    broadcast({ type: "invalidate", topics: ["labels"] });
    return { ...l, threadCount: 0, unreadThreadCount: 0 };
  },
  "labels.update": ({ labelId, ...patch }) => {
    const l = labels.find((x) => x.id === labelId);
    Object.assign(l, patch);
    broadcast({ type: "invalidate", topics: ["labels"] });
    return { ...l, threadCount: 0, unreadThreadCount: 0 };
  },
  "labels.delete": ({ labelId }) => {
    labels.splice(labels.findIndex((l) => l.id === labelId), 1);
    threads.forEach((t) => (t.labelIds = t.labelIds.filter((l) => l !== labelId)));
    broadcast({ type: "invalidate", topics: ["labels", "threads"] });
    return {};
  },
  "labels.reorder": ({ labelIds }) => {
    labelIds.forEach((lid, i) => (labels.find((l) => l.id === lid).sortOrder = i));
    broadcast({ type: "invalidate", topics: ["labels"] });
    return {};
  },
  "groups.create": ({ name, color }) => {
    const g = { id: id("g"), name, color: color ?? "#64748b", sortOrder: groups.length, collapsed: false };
    groups.push(g);
    broadcast({ type: "invalidate", topics: ["groups"] });
    return { ...g, unreadInboxCount: 0 };
  },
  "groups.update": ({ groupId, ...patch }) => {
    const g = groups.find((x) => x.id === groupId);
    Object.assign(g, patch);
    broadcast({ type: "invalidate", topics: ["groups"] });
    return { ...g, unreadInboxCount: 0 };
  },
  "groups.delete": ({ groupId }) => {
    groups.splice(groups.findIndex((g) => g.id === groupId), 1);
    accounts.forEach((a) => a.groupId === groupId && (a.groupId = null));
    broadcast({ type: "invalidate", topics: ["groups", "accounts"] });
    return {};
  },
  "groups.reorder": ({ groupIds }) => {
    groupIds.forEach((gid, i) => (groups.find((g) => g.id === gid).sortOrder = i));
    broadcast({ type: "invalidate", topics: ["groups"] });
    return {};
  },
  "accounts.detect": ({ email }) => {
    const domain = email.split("@")[1] ?? "";
    if (domain.startsWith("gmail")) return { provider: "gmail", presetId: "gmail", name: "Gmail", imap: { host: "imap.gmail.com", port: 993, secure: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true }, auth: ["password", "oauth-google"], appPasswordUrl: "https://myaccount.google.com/apppasswords", passwordHint: "Use an app password, not your Google password. It needs 2-Step Verification, works until you change your Google password, and never expires on its own." };
    return { provider: "imap", presetId: null, name: "IMAP", imap: { host: `imap.${domain}`, port: 993, secure: true }, smtp: { host: `smtp.${domain}`, port: 465, secure: true }, auth: ["password"], appPasswordUrl: null, passwordHint: null };
  },
  "accounts.addWithPassword": async (p) => {
    await new Promise((r) => setTimeout(r, 900));
    if (p.password !== "right") throw new RpcError("auth_failed", "The server refused the password. Check it, or create a new app password.");
    const a = { id: id("a"), email: p.email, displayName: p.displayName, senderName: p.displayName, provider: p.provider, authKind: "password", groupId: p.groupId ?? null, color: "#3b82f6", sortOrder: accounts.length, agentAccess: settings.defaultAgentAccess, signature: "", imap: p.imap, smtp: p.smtp, status: status("syncing"), createdAt: Date.now() };
    accounts.push(a);
    broadcast({ type: "invalidate", topics: ["accounts"] });
    return { ...a, unreadInboxCount: 0 };
  },
  "accounts.startOAuth": () => ({ flowId: id("flow"), authUrl: "https://accounts.google.com/o/oauth2/v2/auth?mock=1" }),
  "accounts.cancelOAuth": () => ({}),
  "accounts.reconnect": ({ accountId }) => {
    const a = accounts.find((x) => x.id === accountId);
    a.status = status("ready");
    broadcast({ type: "accountStatus", accountId, status: a.status });
    return { ...a, unreadInboxCount: 0 };
  },
  "accounts.update": ({ accountId, paused, ...patch }) => {
    const a = accounts.find((x) => x.id === accountId);
    Object.assign(a, patch);
    if (paused !== undefined) a.status = status(paused ? "paused" : "ready");
    broadcast({ type: "invalidate", topics: ["accounts"] });
    return { ...a, unreadInboxCount: 0 };
  },
  "accounts.reorder": ({ accountIds, groupId }) => {
    accountIds.forEach((aid, i) => {
      const a = accounts.find((x) => x.id === aid);
      a.sortOrder = i;
      if (groupId !== undefined) a.groupId = groupId;
    });
    broadcast({ type: "invalidate", topics: ["accounts"] });
    return {};
  },
  "accounts.remove": ({ accountId }) => {
    accounts.splice(accounts.findIndex((a) => a.id === accountId), 1);
    broadcast({ type: "invalidate", topics: ["accounts", "threads"] });
    return {};
  },
  "accounts.syncNow": () => ({}),
  "contacts.suggest": ({ query, limit = 8 }) => {
    const q = query.trim().toLowerCase();
    const seen = new Map();
    for (const t of threads) for (const p of t.participants ?? []) {
      if (!p?.address || seen.has(p.address)) continue;
      if ((p.name ?? "").toLowerCase().includes(q) || p.address.toLowerCase().includes(q)) seen.set(p.address, { name: p.name ?? null, address: p.address });
    }
    return [...seen.values()].slice(0, limit);
  },
  "drafts.get": ({ draftId }) => drafts.find((d) => d.id === draftId) ?? (() => { throw new RpcError("not_found", "That draft is gone."); })(),
  "drafts.list": () => drafts.filter((d) => d.sendState !== "sent"),
  "drafts.save": ({ draft }) => {
    let d = draft.id ? drafts.find((x) => x.id === draft.id) : null;
    if (!d) {
      d = { id: id("d"), conversationId: draft.threadId ?? id("t"), createdBy: { kind: "user" }, sendState: "draft", sendError: null, sendAt: null };
      drafts.push(d);
    }
    Object.assign(d, draft, { id: d.id, updatedAt: Date.now() });
    broadcast({ type: "invalidate", topics: ["drafts"], ...(d.threadId ? { threadIds: [d.threadId] } : {}) });
    return d;
  },
  "drafts.delete": ({ draftId }) => {
    const i = drafts.findIndex((d) => d.id === draftId);
    if (i >= 0) {
      const [d] = drafts.splice(i, 1);
      const t = threads.find((x) => x.id === d.threadId);
      if (t) t.draftCount = Math.max(0, t.draftCount - 1);
    }
    broadcast({ type: "invalidate", topics: ["drafts", "threads"] });
    return {};
  },
  "drafts.send": ({ draftId, undoable }) => {
    const d = drafts.find((x) => x.id === draftId);
    d.sendState = "queued";
    const wait = undoable ? settings.undoSendSeconds * 1000 : 0;
    const go = () => {
      d.sendAt = null;
      setTimeout(() => {
        d.sendState = "sent";
        const t = threads.find((x) => x.id === d.threadId);
        if (t) t.draftCount = Math.max(0, t.draftCount - 1);
        broadcast({ type: "draftSent", draftId, ok: true, error: null });
        broadcast({ type: "invalidate", topics: ["drafts", "threads"] });
      }, 1200);
    };
    d.sendAt = wait > 0 ? Date.now() + wait : null;
    if (wait > 0) sendWaits.set(draftId, { timer: setTimeout(() => { sendWaits.delete(draftId); go(); }, wait), go });
    else go();
    return d;
  },
  "drafts.cancelSend": ({ draftId }) => {
    const d = drafts.find((x) => x.id === draftId);
    const w = sendWaits.get(draftId);
    if (!w) throw new RpcError("conflict", "Too late: it's already on its way.");
    clearTimeout(w.timer);
    sendWaits.delete(draftId);
    Object.assign(d, { sendState: "draft", sendAt: null });
    broadcast({ type: "invalidate", topics: ["drafts", "threads"] });
    return d;
  },
  "drafts.sendNow": ({ draftId }) => {
    const w = sendWaits.get(draftId);
    if (w) {
      clearTimeout(w.timer);
      sendWaits.delete(draftId);
      w.go();
    }
    return {};
  },
  "activity.list": ({ cursor, limit = 50 }) => {
    const start = cursor ? Number(cursor) : 0;
    return { items: activity.slice(start, start + limit), nextCursor: start + limit < activity.length ? String(start + limit) : null };
  },
  "activity.undo": ({ activityId }) => {
    const act = activity.find((a) => a.id === activityId);
    const snap = snapshots.get(activityId);
    if (snap) snap.forEach((before) => Object.assign(threads.find((t) => t.id === before.id), before));
    act.undoneAt = Date.now();
    broadcast({ type: "invalidate", topics: ["threads", "activity"] });
    return act;
  },
  "settings.update": ({ patch }) => {
    settings = { ...settings, ...patch };
    broadcast({ type: "invalidate", topics: ["settings"] });
    return settings;
  },
  "mcp.info": () => bootstrap().mcp,
  "mcp.rotateToken": () => {
    mcpToken = `fm_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
    return bootstrap().mcp;
  },
  "demo.remove": () => {
    hasDemoData = false;
    broadcast({ type: "invalidate", topics: ["accounts"] });
    return {};
  },
  "demo.reset": () => {
    hasDemoData = true;
    broadcast({ type: "invalidate", topics: ["accounts"] });
    return {};
  },
};

// ── Transport ───────────────────────────────────────────────────────────────────────────────

const sockets = new Set();
function broadcast(event) {
  const frame = JSON.stringify({ event });
  for (const ws of sockets) ws.send(frame);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/session") {
    res.writeHead(204, { "set-cookie": "fm_session=mock; Path=/; HttpOnly; SameSite=Strict" });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/attachments/")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("A mock attachment.");
    return;
  }
  if (url.pathname === "/api/uploads" && req.method === "POST") {
    let size = 0;
    req.on("data", (c) => (size += c.length));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: id("up"), filename: decodeURIComponent(String(req.headers["x-filename"] ?? "file")), mimeType: String(req.headers["content-type"] ?? "application/octet-stream"), size }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.on("message", async (raw) => {
    let req;
    try {
      req = JSON.parse(String(raw));
    } catch {
      return;
    }
    const handler = handlers[req.method];
    try {
      if (!handler) throw new RpcError("bad_request", `Unknown method ${req.method}.`);
      const result = await handler(req.params ?? {});
      ws.send(JSON.stringify({ id: req.id, ok: true, result }));
    } catch (error) {
      ws.send(JSON.stringify({ id: req.id, ok: false, error: { code: error.code ?? "internal", message: error.message } }));
    }
  });
});

// An agent doing something now and then, to see the toast.
if (process.env.MOCK_AGENT === "1") {
  setTimeout(() => modify({ threadIds: ["t_3", "t_15"], actions: [{ type: "addLabels", labelIds: ["l_travel"] }] }, { kind: "agent", name: "claude-code" }), 2500);
}

server.listen(PORT, "127.0.0.1", () => console.log(`mock server on http://127.0.0.1:${PORT}`));
