import { describe, expect, it } from "vitest";

import type { OutboxMessageChange } from "../store/activity.ts";
import { classifyError, smtpSendMessage, OAuthGrantError } from "./errors.ts";
import type { ErrorContext } from "./errors.ts";
import { failedOpsMessage, groupCommands, planGmailChange, planImapChange, reconnectDelayMs, retryDelayMs } from "./outbox.ts";
import type { ServerCopy } from "./outbox.ts";

const PATHS = { inbox: "INBOX", all: "[Gmail]/All Mail", trash: "[Gmail]/Trash", spam: "[Gmail]/Spam" };
const ALL: ServerCopy = { path: "[Gmail]/All Mail", mailboxId: "mbx_all", role: "all", uid: 41 };
const TRASH: ServerCopy = { path: "[Gmail]/Trash", mailboxId: "mbx_trash", role: "trash", uid: 7 };

function change(over: Partial<OutboxMessageChange>): OutboxMessageChange {
  return {
    message: { id: "msg_1", remoteId: "1789", messageIdHeader: "<1@x>", gmThreadId: null },
    addTo: [],
    removeFrom: [],
    addLabels: [],
    removeLabels: [],
    ...over,
  };
}

const box = (id: string, path: string, role: string | null) => ({ id, path, role: role as never });

describe("Gmail outbox translation", () => {
  it("read and star are flags on the All Mail copy", () => {
    expect(planGmailChange(change({ seen: true, flagged: true }), ALL, PATHS)).toEqual([
      { type: "flags", path: "[Gmail]/All Mail", uid: 41, messageId: "msg_1", add: ["\\Seen", "\\Flagged"], remove: [], useLabels: false },
    ]);
  });

  it("archive removes \\Inbox, move to inbox adds it", () => {
    const archive = planGmailChange(change({ removeFrom: [{ ...box("mbx_in", "INBOX", "inbox"), uid: null }] }), ALL, PATHS);
    expect(archive).toEqual([{ type: "flags", path: "[Gmail]/All Mail", uid: 41, messageId: "msg_1", add: [], remove: ["\\Inbox"], useLabels: true }]);
    const back = planGmailChange(change({ addTo: [box("mbx_in", "INBOX", "inbox")] }), ALL, PATHS);
    expect(back[0]).toMatchObject({ type: "flags", add: ["\\Inbox"], useLabels: true });
  });

  it("trash and spam are moves; restore moves back to INBOX or All Mail", () => {
    const trash = change({ addTo: [box("mbx_trash", "[Gmail]/Trash", "trash")], removeFrom: [{ ...box("mbx_all", "[Gmail]/All Mail", "all"), uid: 41 }] });
    expect(planGmailChange(trash, ALL, PATHS)).toEqual([{ type: "move", path: "[Gmail]/All Mail", uid: 41, messageId: "msg_1", to: "[Gmail]/Trash", toMailboxId: "mbx_trash" }]);
    const restoreInbox = change({ removeFrom: [{ ...box("mbx_trash", "[Gmail]/Trash", "trash"), uid: 7 }], addTo: [box("mbx_in", "INBOX", "inbox"), box("mbx_all", "[Gmail]/All Mail", "all")] });
    expect(planGmailChange(restoreInbox, TRASH, PATHS)[0]).toMatchObject({ type: "move", path: "[Gmail]/Trash", to: "INBOX" });
    const restoreArchived = change({ removeFrom: [{ ...box("mbx_trash", "[Gmail]/Trash", "trash"), uid: 7 }], addTo: [box("mbx_all", "[Gmail]/All Mail", "all")] });
    expect(planGmailChange(restoreArchived, TRASH, PATHS)[0]).toMatchObject({ type: "move", to: "[Gmail]/All Mail" });
  });

  it("labels go by name through X-GM-LABELS", () => {
    expect(planGmailChange(change({ addLabels: ["Invoices"], removeLabels: ["Old"] }), ALL, PATHS)).toEqual([
      { type: "flags", path: "[Gmail]/All Mail", uid: 41, messageId: "msg_1", add: ["Invoices"], remove: ["Old"], useLabels: true },
    ]);
  });

  it("does nothing for a message that isn't on the server", () => {
    expect(planGmailChange(change({ seen: true }), null, PATHS)).toEqual([]);
  });
});

describe("IMAP outbox translation", () => {
  const INBOX: ServerCopy = { path: "INBOX", mailboxId: "mbx_in", role: "inbox", uid: 5 };
  const SENT: ServerCopy = { path: "Sent", mailboxId: "mbx_sent", role: "sent", uid: 9 };

  it("flags and keywords on every copy", () => {
    const cmds = planImapChange(change({ seen: false, addLabels: ["Work Stuff"] }), [INBOX, SENT], { keywords: true });
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toMatchObject({ type: "flags", path: "INBOX", uid: 5, add: ["$FM_Work_20Stuff"], remove: ["\\Seen"] });
    expect(cmds[1]).toMatchObject({ path: "Sent", uid: 9 });
  });

  it("leaves labels local when the server takes no keywords", () => {
    expect(planImapChange(change({ addLabels: ["X"] }), [INBOX], { keywords: false })).toEqual([]);
  });

  it("archive is a move INBOX → Archive", () => {
    const cmds = planImapChange(change({ removeFrom: [{ ...box("mbx_in", "INBOX", "inbox"), uid: 5 }], addTo: [box("mbx_arch", "Archive", "archive")] }), [INBOX], { keywords: true });
    expect(cmds).toEqual([{ type: "move", path: "INBOX", uid: 5, messageId: "msg_1", to: "Archive", toMailboxId: "mbx_arch" }]);
  });

  it("trash from two folders moves both copies; restore to two folders copies first", () => {
    const trash = planImapChange(
      change({ removeFrom: [{ ...box("mbx_in", "INBOX", "inbox"), uid: 5 }, { ...box("mbx_sent", "Sent", "sent"), uid: 9 }], addTo: [box("mbx_trash", "Trash", "trash")] }),
      [INBOX, SENT],
      { keywords: true },
    );
    expect(trash.map((c) => `${c.type} ${c.path}→${c.type === "flags" ? "" : c.to}`)).toEqual(["move INBOX→Trash", "move Sent→Trash"]);
    const T: ServerCopy = { path: "Trash", mailboxId: "mbx_trash", role: "trash", uid: 3 };
    const restore = planImapChange(
      change({ removeFrom: [{ ...box("mbx_trash", "Trash", "trash"), uid: 3 }], addTo: [box("mbx_in", "INBOX", "inbox"), box("mbx_sent", "Sent", "sent")] }),
      [T],
      { keywords: true },
    );
    expect(restore.map((c) => `${c.type} ${c.path}→${c.type === "flags" ? "" : c.to}`)).toEqual(["copy Trash→Sent", "move Trash→INBOX"]);
  });

  it("never deletes: a change that only removes a location does nothing on the server", () => {
    expect(planImapChange(change({ removeFrom: [{ ...box("mbx_in", "INBOX", "inbox"), uid: 5 }] }), [INBOX], { keywords: true })).toEqual([]);
  });

  it("groups commands into one per folder and target, flags before moves", () => {
    const a = planImapChange(change({ message: { id: "m1", remoteId: null, messageIdHeader: null, gmThreadId: null }, removeFrom: [{ ...box("mbx_in", "INBOX", "inbox"), uid: 5 }], addTo: [box("a", "Archive", "archive")] }), [INBOX], { keywords: true });
    const b = planImapChange(change({ message: { id: "m2", remoteId: null, messageIdHeader: null, gmThreadId: null }, seen: true }), [{ ...INBOX, uid: 6 }], { keywords: true });
    const c = planImapChange(change({ message: { id: "m3", remoteId: null, messageIdHeader: null, gmThreadId: null }, removeFrom: [{ ...box("mbx_in", "INBOX", "inbox"), uid: 8 }], addTo: [box("a", "Archive", "archive")] }), [{ ...INBOX, uid: 8 }], { keywords: true });
    const groups = groupCommands([...a, ...b, ...c]);
    expect(groups.map((g) => [g.first.type, g.items.map((i) => i.uid)])).toEqual([
      ["flags", [6]],
      ["move", [5, 8]],
    ]);
  });

  it("splits a big change into steps, keeping each message's commands together", () => {
    const move = (uid: number) => ({ type: "move" as const, path: "[Gmail]/All Mail", uid, messageId: `m${uid}`, to: "[Gmail]/Trash", toMailboxId: "t" });
    const commands = [1, 2, 3, 2, 4, 5].map(move);
    const groups = groupCommands(commands, 2);
    expect(groups.map((g) => g.items.map((i) => i.uid))).toEqual([[1, 2, 2], [3, 4], [5]]);
    expect(groupCommands(Array.from({ length: 1201 }, (_, i) => move(i + 1))).map((g) => g.items.length)).toEqual([500, 500, 201]);
  });
});

describe("retry schedules", () => {
  it("reconnects after 5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelayMs)).toEqual([5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
  });

  it("retries a failed change with growing waits, and says when changes didn't make it", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(7)).toBeGreaterThan(retryDelayMs(3));
    expect(failedOpsMessage(0)).toBeNull();
    expect(failedOpsMessage(2)).toBe("2 changes couldn't be saved on the server. Sync now to try again.");
  });
});

describe("errors in words for a person", () => {
  const gmail: ErrorContext = { host: "imap.gmail.com", provider: "gmail", mode: "background", protocol: "imap", email: "me@gmail.com" };
  const other: ErrorContext = { host: "imap.example.test", provider: "imap", mode: "background", protocol: "imap", email: "me@example.test" };

  it("Gmail auth failures explain app passwords", () => {
    const refused = Object.assign(new Error("Authentication failed"), { authenticationFailed: true, responseText: "[AUTHENTICATIONFAILED] Invalid credentials (Failure)" });
    expect(classifyError(refused, gmail)).toEqual({
      kind: "auth",
      message: "Google refused the app password. It stops working when you change your Google password — make a new one and reconnect.",
    });
    expect(classifyError(refused, { ...gmail, mode: "test" }).message).toMatch(/needs an app password/);
    const asp = Object.assign(new Error("Authentication failed"), { authenticationFailed: true, responseText: "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)" });
    expect(classifyError(asp, { ...gmail, mode: "test" }).message).toMatch(/app password here, not your Google password/);
  });

  it("revoked OAuth is auth-required with a sign-in-again message", () => {
    expect(classifyError(new OAuthGrantError("invalid_grant", "x"), { ...gmail, protocol: "oauth" })).toMatchObject({ kind: "auth", message: expect.stringMatching(/Sign in again/) });
  });

  it("network trouble is offline and keeps trying", () => {
    expect(classifyError(Object.assign(new Error("getaddrinfo ENOTFOUND imap.gmail.com"), { code: "ENOTFOUND" }), gmail)).toEqual({ kind: "network", message: "Can't reach imap.gmail.com — will keep trying." });
    expect(classifyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), { ...other, mode: "test" }).message).toMatch(/refused the connection. Check the port/);
    expect(classifyError(Object.assign(new Error("Connection timed out"), { code: "CONNECT_TIMEOUT" }), other).kind).toBe("network");
    expect(classifyError(Object.assign(new Error("fetch failed"), { cause: { code: "EAI_AGAIN" } }), other).kind).toBe("network");
  });

  it("never repeats the command that was sent (it may hold the password)", () => {
    const e = Object.assign(new Error("Command failed"), { executedCommand: "A1 LOGIN me hunter2", responseText: "Server busy" });
    const c = classifyError(e, other);
    expect(c.kind).toBe("other");
    expect(c.message).not.toContain("hunter2");
    expect(c.message).toContain("Server busy");
  });

  it("send failures name the refused recipient", () => {
    const e = Object.assign(new Error("Can't send mail - all recipients were rejected"), { code: "EENVELOPE", rejected: ["bob@x.test"], response: "550 5.1.1 <bob@x.test>: mailbox unavailable", responseCode: 550 });
    expect(smtpSendMessage(e, { ...other, protocol: "smtp", mode: "test" })).toBe("The server refused the recipient bob@x.test: <bob@x.test>: mailbox unavailable. The message wasn't sent.");
  });
});
