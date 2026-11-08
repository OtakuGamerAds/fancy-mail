/**
 * The real sync engine against a real IMAP/SMTP server: Ethereal, nodemailer's free throwaway
 * mail service (made for exactly this). No real person's account is involved.
 *
 *   node scripts/electron-node.mjs apps/server/scripts/ethereal-e2e.ts [--keep]
 *
 * Creates a fresh Ethereal account, sends it a few messages (one with a PDF, a reply with
 * In-Reply-To, an HTML-only one), starts the real server on a temp data dir (--no-demo), adds
 * the account over the WebSocket RPC and checks, with a separate IMAP connection, that what the
 * app does reaches the server and what happens on the server reaches the app. Prints a PASS/FAIL
 * table; exits 1 when anything failed. --keep leaves the temp data dir for a look.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import WebSocket from "ws";

import { openDb } from "../src/db/sqlite.ts";
import { createVault } from "../src/services/vault.ts";
import { labelToKeyword } from "../src/sync/keywords.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes("--keep");

// ── Reporting ───────────────────────────────────────────────────────────────────────────────

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, raw = ""): boolean {
  const detail = raw.replace(/\s+/g, " ").trim();
  results.push({ name, ok, detail });
  process.stderr.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
  return ok;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 500): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // try again
    }
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── The server ──────────────────────────────────────────────────────────────────────────────

interface Running {
  url: string;
  token: string;
  child: ChildProcess;
  stderr: () => string;
}

async function startServer(dataDir: string): Promise<Running> {
  const child = spawn(process.execPath, [path.join(here, "..", "src", "bin.ts"), "--data-dir", dataDir, "--port", "0", "--dev", "--no-demo"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1", FANCY_MAIL_LOG_LEVEL: process.env.FANCY_MAIL_LOG_LEVEL ?? "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const ready = await new Promise<{ url: string; sessionToken: string }>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start in 30 s\n${stderr}`)), 30_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as { url: string; sessionToken: string });
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}\n${stderr}`)));
  });
  return { url: ready.url, token: ready.sessionToken, child, stderr: () => stderr };
}

async function stopServer(server: Running): Promise<void> {
  if (server.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.child.once("exit", () => resolve()));
  server.child.kill(); // the process we started, by its handle (pid server.child.pid)
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

type Event = { type: string; [key: string]: unknown };

class Rpc {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error & { code?: string }) => void }>();
  events: Event[] = [];

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: Event };
      if (frame.event) {
        this.events.push(frame.event);
        return;
      }
      const p = this.#pending.get(frame.id!);
      if (!p) return;
      this.#pending.delete(frame.id!);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(Object.assign(new Error(frame.error!.message), { code: frame.error!.code }));
    });
  }

  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.#ws.close();
  }
}

async function connect(server: Running): Promise<{ rpc: Rpc; cookie: string }> {
  const session = await fetch(`${server.url}/api/session?t=${encodeURIComponent(server.token)}`);
  const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const ws = new WebSocket(`${server.url.replace("http", "ws")}/ws`, { headers: { Cookie: cookie, Origin: server.url } });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { rpc: new Rpc(ws), cookie };
}

// ── Mail on the server ──────────────────────────────────────────────────────────────────────

/** A tiny but valid PDF. */
function pdfBytes(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 40 Td (Q3 report) Tj ET";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += body === null ? `${i + 1} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n` : `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

interface ServerMessage {
  uid: number;
  flags: Set<string>;
  subject: string;
  messageId: string;
}

async function withImap<T>(account: { user: string; pass: string }, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({ host: "imap.ethereal.email", port: 993, secure: true, auth: { user: account.user, pass: account.pass }, logger: false });
  client.on("error", () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function listFolder(client: ImapFlow, folder: string): Promise<ServerMessage[]> {
  const exists = (await client.list()).some((m) => m.path === folder);
  if (!exists) return [];
  const lock = await client.getMailboxLock(folder);
  try {
    if ((client.mailbox as { exists: number }).exists === 0) return [];
    const out: ServerMessage[] = [];
    for await (const m of client.fetch("1:*", { uid: true, flags: true, envelope: true })) {
      out.push({ uid: m.uid, flags: m.flags ?? new Set(), subject: m.envelope?.subject ?? "", messageId: m.envelope?.messageId ?? "" });
    }
    return out;
  } finally {
    lock.release();
  }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();
  const test = await nodemailer.createTestAccount();
  const account = { user: test.user, pass: test.pass };
  process.stderr.write(`Ethereal account ${test.user}\n`);
  const smtp = nodemailer.createTransport({ host: test.smtp.host, port: test.smtp.port, secure: test.smtp.secure, auth: account });

  // 1. Mail for the account.
  const pdf = pdfBytes();
  const a = await smtp.sendMail({
    from: { name: "Ada Analyst", address: test.user },
    to: test.user,
    subject: "Quarterly report Q3",
    text: "Hi,\n\nthe Q3 numbers are attached. Revenue is up eleven percent.\n\nAda",
    attachments: [{ filename: "report.pdf", content: pdf, contentType: "application/pdf" }],
  });
  const b = await smtp.sendMail({ from: { name: "Bob Builder", address: test.user }, to: test.user, subject: "Lunch on Friday?", text: "Shall we get pineapple pizza on Friday?" });
  const c = await smtp.sendMail({
    from: { name: "Carol Chef", address: test.user },
    to: test.user,
    subject: "Re: Lunch on Friday?",
    text: "Yes! Noon at the usual place.",
    inReplyTo: b.messageId,
    references: [b.messageId],
  });
  await smtp.sendMail({ from: { name: "The Digest", address: test.user }, to: test.user, subject: "Weekly digest", html: "<h1>This week</h1><p>Hello <b>digest</b> readers, the <a href='https://example.test'>news</a>.</p>" });
  const seeded = await waitFor(async () => withImap(account, async (cl) => ((await listFolder(cl, "INBOX")).length >= 4 ? true : null)), 30_000, 1000);
  check("seed: 4 messages in the Ethereal INBOX", seeded === true);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-ethereal-"));
  let server = await startServer(dataDir);
  process.stderr.write(`server pid ${server.child.pid} on ${server.url}, data in ${dataDir}\n`);
  let { rpc, cookie } = await connect(server);

  try {
    // 2. A wrong password is refused with words for a person, and saves nothing.
    try {
      await rpc.call("accounts.addWithPassword", {
        email: test.user,
        displayName: "Ethereal",
        password: "definitely-wrong",
        provider: "imap",
        imap: { host: test.imap.host, port: test.imap.port, secure: test.imap.secure },
        smtp: { host: test.smtp.host, port: test.smtp.port, secure: test.smtp.secure },
      });
      check("wrong password is refused", false, "it was accepted");
    } catch (error) {
      const e = error as Error & { code?: string };
      const boot = await rpc.call("app.bootstrap");
      check("wrong password is refused", e.code === "auth_failed" && !e.message.includes("definitely-wrong") && boot.accounts.length === 0, `${e.code}: ${e.message}`);
    }

    // 3. Add the account; the first sync runs.
    const added = await rpc.call("accounts.addWithPassword", {
      email: test.user,
      displayName: "Ethereal Test",
      password: test.pass,
      provider: "imap",
      imap: { host: test.imap.host, port: test.imap.port, secure: test.imap.secure },
      smtp: { host: test.smtp.host, port: test.smtp.port, secure: test.smtp.secure },
    });
    const accountId = added.id as string;
    const ready = await waitFor(async () => {
      const boot = await rpc.call("app.bootstrap");
      const acc = boot.accounts.find((x: { id: string }) => x.id === accountId);
      return acc?.status.state === "ready" ? acc : null;
    }, 120_000, 1000);
    const states = [...new Set(rpc.events.filter((e) => e.type === "accountStatus").map((e) => `${(e.status as { state: string }).state}${(e.status as { message: string | null }).message ? ` (${(e.status as { message: string }).message})` : ""}`))];
    check("account added, first sync reaches ready", ready !== null, states.join(" → "));
    if (!ready) throw new Error("not ready");

    // 4. Search.
    const quarterly = await rpc.call("threads.search", { query: "Quarterly" });
    check("search finds a message by subject", quarterly.threads.length === 1, `${quarterly.threads.length} result(s)`);
    const inbox = await rpc.call("threads.search", { query: "in:inbox" });
    check("inbox shows 3 conversations for 4 messages", inbox.threads.length === 3, inbox.threads.map((t: { subject: string; messageCount: number }) => `${t.subject} (${t.messageCount})`).join(", "));

    // 5. Threading: the reply joined its message.
    const lunch = inbox.threads.find((t: { subject: string }) => /lunch/i.test(t.subject));
    check("reply (In-Reply-To) grouped with its message", lunch?.messageCount === 2, `Lunch thread: ${lunch?.messageCount ?? 0} messages`);

    // 6. Bodies.
    const qThread = quarterly.threads[0];
    const qDetail = await waitFor(async () => {
      const d = await rpc.call("threads.get", { threadId: qThread.id });
      return d.messages.every((m: { body: unknown }) => m.body !== null) ? d : null;
    }, 30_000);
    const qMessage = qDetail?.messages[0];
    check("threads.get returns the body", Boolean(qMessage?.body?.text?.includes("eleven percent")), qMessage?.body?.text?.slice(0, 60) ?? "no body");
    const digest = inbox.threads.find((t: { subject: string }) => t.subject === "Weekly digest");
    const dDetail = digest
      ? await waitFor(async () => {
          const d = await rpc.call("threads.get", { threadId: digest.id });
          return d.messages[0]?.body ? d : null;
        }, 30_000)
      : null;
    const dBody = dDetail?.messages[0]?.body;
    check("HTML-only message: html kept, text made from it", Boolean(dBody?.html?.includes("<b>digest</b>") && dBody?.text?.includes("digest readers")), dBody?.text?.slice(0, 50) ?? "no body");
    const snippetOk = (await rpc.call("threads.search", { query: "Quarterly" })).threads[0]?.snippet?.includes("Q3 numbers");
    check("snippet filled in after the body arrived", Boolean(snippetOk));

    // 7. Attachment.
    const att = qMessage?.attachments?.find((x: { filename: string }) => x.filename === "report.pdf");
    let attOk = false;
    let attDetail = "no attachment in the message";
    if (att) {
      const res = await fetch(`${server.url}/api/attachments/${att.id}`, { headers: { Cookie: cookie } });
      const bytes = Buffer.from(await res.arrayBuffer());
      attOk = res.status === 200 && bytes.equals(pdf);
      attDetail = `${res.status} ${res.headers.get("content-type")} ${bytes.length} bytes${bytes.equals(pdf) ? ", identical to what was sent" : ", DIFFERENT"}`;
    }
    check("attachment downloads, byte-identical", attOk, attDetail);

    // 8. Full-text search over bodies.
    const lunchDetail = await waitFor(async () => {
      const d = await rpc.call("threads.get", { threadId: lunch.id });
      return d.messages.every((m: { body: unknown }) => m.body !== null) ? d : null;
    }, 30_000);
    const pine = await rpc.call("threads.search", { query: "pineapple" });
    check("search finds words in downloaded bodies", pine.threads.some((t: { id: string }) => t.id === lunch.id), `${pine.threads.length} result(s)`);

    // 9. Star + read reach the server.
    await rpc.call("threads.modify", { threadIds: [qThread.id], actions: [{ type: "star" }, { type: "markRead" }] });
    const flagged = await waitFor(
      () =>
        withImap(account, async (cl) => {
          const m = (await listFolder(cl, "INBOX")).find((x) => x.subject === "Quarterly report Q3");
          return m && m.flags.has("\\Flagged") && m.flags.has("\\Seen") ? m : null;
        }),
      30_000,
      1500,
    );
    check("star + mark read reach the server (\\Flagged \\Seen)", flagged !== null, flagged ? [...flagged.flags].join(" ") : "flags not set");

    // 10. A label becomes a keyword (with a non-ASCII name).
    const label = await rpc.call("labels.create", { name: "Projekt Über" });
    await rpc.call("threads.modify", { threadIds: [qThread.id], actions: [{ type: "addLabels", labelIds: [label.id] }] });
    const keyword = labelToKeyword("Projekt Über");
    const labeled = await waitFor(
      () =>
        withImap(account, async (cl) => {
          const m = (await listFolder(cl, "INBOX")).find((x) => x.subject === "Quarterly report Q3");
          return m?.flags.has(keyword) ? m : null;
        }),
      30_000,
      1500,
    );
    check("label becomes an IMAP keyword", labeled !== null, `${keyword}${labeled ? " set" : " missing"}`);

    // 11. Archive moves INBOX → Archive (created, since Ethereal has none).
    await rpc.call("threads.modify", { threadIds: [lunch.id], actions: [{ type: "archive" }] });
    const archived = await waitFor(
      () =>
        withImap(account, async (cl) => {
          const inboxNow = await listFolder(cl, "INBOX");
          const archive = await listFolder(cl, "Archive");
          const lunchIn = inboxNow.filter((x) => /lunch/i.test(x.subject)).length;
          const lunchArch = archive.filter((x) => /lunch/i.test(x.subject)).length;
          return lunchIn === 0 && lunchArch === 2 ? { lunchArch } : null;
        }),
      30_000,
      1500,
    );
    check("archive moves the conversation to Archive on the server", archived !== null, archived ? "2 messages in Archive, none in INBOX" : "not moved");

    // 12. Trash moves to Trash; 13. undo brings it back with its flags and keyword.
    const trashed = await rpc.call("threads.modify", { threadIds: [qThread.id], actions: [{ type: "trash" }] });
    const inTrash = await waitFor(
      () =>
        withImap(account, async (cl) => {
          const t = (await listFolder(cl, "Trash")).find((x) => x.subject === "Quarterly report Q3");
          const still = (await listFolder(cl, "INBOX")).some((x) => x.subject === "Quarterly report Q3");
          return t && !still ? t : null;
        }),
      30_000,
      1500,
    );
    check("trash moves the message to Trash on the server", inTrash !== null);
    await rpc.call("activity.undo", { activityId: trashed.activity.id });
    const back = await waitFor(
      () =>
        withImap(account, async (cl) => {
          const m = (await listFolder(cl, "INBOX")).find((x) => x.subject === "Quarterly report Q3");
          const t = (await listFolder(cl, "Trash")).some((x) => x.subject === "Quarterly report Q3");
          return m && !t ? m : null;
        }),
      30_000,
      1500,
    );
    check("undo of trash moves it back to INBOX, flags and keyword kept", Boolean(back && back.flags.has("\\Flagged") && back.flags.has(keyword)), back ? [...back.flags].join(" ") : "not back");
    const localBack = await waitFor(async () => {
      const r = await rpc.call("threads.search", { query: "in:inbox Quarterly" });
      return r.threads.length === 1 ? r : null;
    }, 10_000);
    check("…and the app shows it in the inbox again", localBack !== null);

    // 14. A change made elsewhere reaches the app.
    await withImap(account, async (cl) => {
      const lock = await cl.getMailboxLock("INBOX");
      try {
        const d = (await cl.search({ subject: "Weekly digest" }, { uid: true })) as number[];
        await cl.messageFlagsAdd(d, ["\\Flagged"], { uid: true });
      } finally {
        lock.release();
      }
    });
    await rpc.call("accounts.syncNow", { accountId });
    const starredRemote = await waitFor(async () => {
      const r = await rpc.call("threads.search", { query: "is:starred digest" });
      return r.threads.length === 1 ? r : null;
    }, 30_000);
    check("a star set in another client shows up (CONDSTORE)", starredRemote !== null);

    // 15. New mail arrives by itself (IDLE).
    const before = rpc.events.length;
    await smtp.sendMail({ from: { name: "Dora Delivery", address: test.user }, to: test.user, subject: "Fresh arrival", text: "This one came in while the app was running." });
    const arrived = await waitFor(async () => {
      const r = await rpc.call("threads.search", { query: "Fresh arrival" });
      return r.threads.length === 1 ? r : null;
    }, 90_000, 1000);
    // The event comes at the end of the pass, a moment after the message is searchable.
    const newMail = await waitFor(async () => rpc.events.slice(before).find((e) => e.type === "newMail") ?? null, 15_000, 250);
    check("new mail shows up without Sync now (IDLE), with a newMail event", arrived !== null && Boolean(newMail), newMail ? `newMail count ${newMail.count}` : "no newMail event");

    // 16. A message moved to Trash in another client moves in the app.
    await withImap(account, async (cl) => {
      const lock = await cl.getMailboxLock("INBOX");
      try {
        const d = (await cl.search({ subject: "Weekly digest" }, { uid: true })) as number[];
        await cl.messageMove(d, "Trash", { uid: true });
      } finally {
        lock.release();
      }
    });
    await rpc.call("accounts.syncNow", { accountId });
    const movedRemote = await waitFor(async () => {
      const t = await rpc.call("threads.search", { query: "in:trash digest" });
      const i = await rpc.call("threads.search", { query: "in:inbox digest" });
      return t.threads.length === 1 && i.threads.length === 0 ? t : null;
    }, 30_000);
    check("a move made in another client shows up (expunge + dedupe)", movedRemote !== null);

    // 17. Send a reply.
    const lastLunch = lunchDetail?.messages.at(-1);
    const draft = await rpc.call("drafts.save", {
      draft: {
        accountId,
        mode: "reply",
        threadId: lunch.id,
        sourceMessageId: lastLunch?.id ?? null,
        to: [{ name: "Carol Chef", address: test.user }],
        cc: [],
        bcc: [],
        subject: "Re: Lunch on Friday?",
        bodyText: "Friday works. See you at noon, with olives.",
        attachments: [],
      },
    });
    const sendStart = rpc.events.length;
    await rpc.call("drafts.send", { draftId: draft.id });
    const sent = await waitFor(async () => rpc.events.slice(sendStart).find((e) => e.type === "draftSent" && e.draftId === draft.id) ?? null, 60_000);
    check("drafts.send succeeds", sent?.ok === true, sent ? (sent.ok ? "draftSent ok" : String(sent.error)) : "no draftSent event");
    const onServer = await waitFor(
      () =>
        withImap(account, async (cl) => {
          const sentBox = (await listFolder(cl, "Sent Mail")).find((x) => x.subject === "Re: Lunch on Friday?");
          const delivered = (await listFolder(cl, "INBOX")).find((x) => x.subject === "Re: Lunch on Friday?");
          return sentBox && delivered ? { sentBox, delivered } : null;
        }),
      60_000,
      2000,
    );
    check("the reply is delivered and saved in Sent (APPEND, \\Seen)", Boolean(onServer && onServer.sentBox.flags.has("\\Seen")), onServer ? `Sent uid ${onServer.sentBox.uid}, INBOX uid ${onServer.delivered.uid}` : "not found");
    const local = await rpc.call("threads.get", { threadId: lunch.id });
    check("the sent reply is in its conversation right away", local.messages.length === 3 && local.drafts.length === 0, `${local.messages.length} messages, ${local.drafts.length} drafts`);
    await rpc.call("accounts.syncNow", { accountId });
    const deduped = await waitFor(async () => {
      const d = await rpc.call("threads.get", { threadId: lunch.id });
      return d.thread.inInbox && d.messages.length === 3 ? d : null;
    }, 30_000);
    check("after sync the delivered copy merges with it (no duplicate)", deduped !== null, deduped ? "3 messages, back in the inbox" : "duplicate or missing");
    const inReplyTo = (await rpc.call("threads.get", { threadId: lunch.id })).messages.at(-1)?.inReplyTo;
    check("the reply carries In-Reply-To", inReplyTo === lastLunch?.messageIdHeader, String(inReplyTo));

    // 18. Restart: still signed in, nothing downloaded twice.
    const countBefore = (await rpc.call("threads.search", { query: "in:anywhere" })).total;
    rpc.close();
    await stopServer(server);
    server = await startServer(dataDir);
    ({ rpc, cookie } = await connect(server));
    const readyAgain = await waitFor(async () => {
      const boot = await rpc.call("app.bootstrap");
      const acc = boot.accounts.find((x: { id: string }) => x.id === accountId);
      return acc?.status.state === "ready" ? acc : null;
    }, 60_000, 1000);
    const countAfter = (await rpc.call("threads.search", { query: "in:anywhere" })).total;
    check("after a restart: signed in again by itself, nothing duplicated", readyAgain !== null && countAfter === countBefore, `${countBefore} → ${countAfter} conversations, status ${readyAgain?.status.state ?? "not ready"}`);

    // 19. The server starts refusing the password (as after a password change): the account
    // waits in "auth-required", keeps its mail, doesn't hammer the server, and Reconnect fixes it.
    rpc.close();
    await stopServer(server);
    {
      const db = openDb(path.join(dataDir, "mail.db"));
      const key = Buffer.from(fs.readFileSync(path.join(dataDir, "vault.key"), "utf8").trim(), "base64");
      createVault(db, key).put(accountId, "password", "an-old-password");
      db.close();
    }
    server = await startServer(dataDir);
    ({ rpc, cookie } = await connect(server));
    const refused = await waitFor(async () => {
      const boot = await rpc.call("app.bootstrap");
      const acc = boot.accounts.find((x: { id: string }) => x.id === accountId);
      return acc?.status.state === "auth-required" ? acc : null;
    }, 60_000, 1000);
    const keptMail = (await rpc.call("threads.search", { query: "in:anywhere" })).total;
    check("refused password → auth-required, account and mail kept", refused !== null && keptMail === countBefore, refused ? `“${refused.status.message}”, ${keptMail} conversations still here` : "state never became auth-required");
    await new Promise((r) => setTimeout(r, 8000));
    const attempts = fs.readFileSync(path.join(dataDir, "logs", "server.log"), "utf8").split("\n").filter((l) => l.includes("sign-in refused")).length;
    check("…and it stops trying instead of hammering the server", attempts === 1, `${attempts} refused sign-in(s) logged`);
    await rpc.call("accounts.reconnect", { accountId, password: test.pass });
    const reconnected = await waitFor(async () => {
      const boot = await rpc.call("app.bootstrap");
      const acc = boot.accounts.find((x: { id: string }) => x.id === accountId);
      return acc?.status.state === "ready" ? acc : null;
    }, 60_000, 1000);
    check("Reconnect with the right password → ready again", reconnected !== null, reconnected ? "ready" : "not ready");

    // 20. Logs never carry the password.
    const log = fs.readFileSync(path.join(dataDir, "logs", "server.log"), "utf8");
    check("the password is in no log line", !log.includes(test.pass) && !log.includes("an-old-password"), `${log.split("\n").length} log lines checked`);
  } catch (error) {
    check("run completed", false, error instanceof Error ? error.message : String(error));
  } finally {
    rpc.close();
    await stopServer(server);
    smtp.close();
    if (!KEEP) fs.rmSync(dataDir, { recursive: true, force: true });
    else process.stderr.write(`kept ${dataDir}\n`);
  }

  const failed = results.filter((r) => !r.ok);
  const width = Math.max(...results.map((r) => r.name.length));
  process.stdout.write(`\nEthereal end-to-end (${Math.round((Date.now() - started) / 1000)} s)\n`);
  for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}\n`);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`\nserver log tail:\n${server.stderr().split("\n").slice(-40).join("\n")}\n`);
    process.exitCode = 1;
  }
}

void main();
