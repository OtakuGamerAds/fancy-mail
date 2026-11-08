import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addAccount, addLabel, addMessage, agent, createTestStack, thread, user } from "../testing.ts";
import type { Built, TestStack } from "../testing.ts";

let stack: TestStack;
let gmail: Built;
let imap: Built;

beforeEach(() => {
  stack = createTestStack();
  gmail = addAccount(stack.store, { email: "me@gmail.test", style: "gmail" });
  imap = addAccount(stack.store, { email: "me@imap.test", style: "imap" });
});
afterEach(() => stack.cleanup());

const row = (id: string) => stack.store.threads.get(id)!;
const roles = (messageId: string) =>
  stack.store.messages
    .locations([messageId])
    .map((l) => l.role)
    .sort();

describe("modify and undo", () => {
  it("archive then undo restores only what was in the inbox (Gmail keeps All Mail)", () => {
    const a = thread();
    const inInbox = addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    const archivedAlready = addMessage(stack.store, gmail, { threadId: a, in: ["all"] });
    const { activity } = stack.services.threads.modify([a], [{ type: "archive" }], user);
    expect(activity?.summary).toBe("Archived 1 conversation");
    expect(roles(inInbox)).toEqual(["all"]);
    expect(row(a).in_inbox).toBe(0);
    expect(row(a).in_archive).toBe(1);

    stack.services.activity.undo(activity!.id, user);
    expect(roles(inInbox)).toEqual(["all", "inbox"]);
    expect(roles(archivedAlready)).toEqual(["all"]);
    expect(row(a).in_inbox).toBe(1);
    expect(stack.services.activity.get(activity!.id).undoneAt).not.toBeNull();
    expect(() => stack.services.activity.undo(activity!.id, user)).toThrow(/already undone/);
  });

  it("IMAP archive moves to an Archive folder it creates, and back on undo", () => {
    const a = thread();
    const m = addMessage(stack.store, imap, { threadId: a, in: ["inbox"] });
    const { activity } = stack.services.threads.modify([a], [{ type: "archive" }], user);
    expect(roles(m)).toEqual(["archive"]);
    const archive = stack.store.mailboxes.byRole(imap.accountId, "archive")!;
    expect(archive.path).toBe("Archive");
    expect(archive.createdLocally).toBe(true);
    // Real accounts get outbox ops (the sync engine applies them on the server).
    const ops = stack.store.outbox.pending(imap.accountId);
    expect(ops.map((o) => o.kind)).toEqual(["createMailbox", "modify"]);
    const payload = ops[1]!.payload as { action: string; changes: { removeFrom: { path: string; uid: number | null }[]; addTo: { path: string }[] }[] };
    expect(payload.action).toBe("archive");
    expect(payload.changes[0]!.removeFrom[0]!.path).toBe("INBOX");
    expect(payload.changes[0]!.removeFrom[0]!.uid).toBeTypeOf("number");
    expect(payload.changes[0]!.addTo[0]!.path).toBe("Archive");

    stack.services.activity.undo(activity!.id, user);
    expect(roles(m)).toEqual(["inbox"]);
  });

  it("markRead undo re-marks only the ones that were unread", () => {
    const a = thread();
    const unread = addMessage(stack.store, gmail, { threadId: a, unread: true, in: ["inbox", "all"] });
    const read = addMessage(stack.store, gmail, { threadId: a, unread: false, in: ["inbox", "all"] });
    const b = thread();
    addMessage(stack.store, gmail, { threadId: b, unread: true, in: ["inbox", "all"] });
    const { activity } = stack.services.threads.modify([a, b], [{ type: "markRead" }], user);
    expect(activity?.summary).toBe("Marked 2 as read");
    expect(row(a).unread_count).toBe(0);
    stack.services.activity.undo(activity!.id, user);
    expect(stack.store.messages.get(unread)!.unread).toBe(true);
    expect(stack.store.messages.get(read)!.unread).toBe(false);
    expect(row(a).unread_count).toBe(1);
    expect(row(b).unread_count).toBe(1);
  });

  it("addLabels / removeLabels with undo, without touching labels added meanwhile", () => {
    const invoices = addLabel(stack.store, "Invoices");
    const taxes = addLabel(stack.store, "Taxes");
    const a = thread();
    const m = addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    const added = stack.services.threads.modify([a], [{ type: "addLabels", labelIds: [invoices] }], agent).activity!;
    expect(added.summary).toBe("Labeled 1 conversation Invoices");
    expect(stack.store.threads.labelIds([a]).get(a)).toEqual([invoices]);
    stack.services.threads.modify([a], [{ type: "addLabels", labelIds: [taxes] }], user);

    stack.services.activity.undo(added.id, user);
    expect(stack.store.messages.labels([m]).map((l) => l.labelId)).toEqual([taxes]);

    const removed = stack.services.threads.modify([a], [{ type: "removeLabels", labelIds: [taxes] }], user).activity!;
    expect(removed.summary).toBe("Removed Taxes from 1 conversation");
    expect(stack.store.threads.labelIds([a]).get(a)).toEqual([]);
    stack.services.activity.undo(removed.id, user);
    expect(stack.store.threads.labelIds([a]).get(a)).toEqual([taxes]);
  });

  it("trash and restore return messages where they were", () => {
    const a = thread();
    const m = addMessage(stack.store, imap, { threadId: a, in: ["inbox"] });
    stack.services.threads.modify([a], [{ type: "trash" }], user);
    expect(roles(m)).toEqual(["trash"]);
    expect(row(a).in_trash).toBe(1);
    expect(stack.services.threads.search({ query: "" }, user).threads).toHaveLength(0);
    // Restore days later, without the undo record: the message remembers where it was.
    const restored = stack.services.threads.modify([a], [{ type: "restore" }], user).activity!;
    expect(restored.summary).toBe("Restored 1 conversation from the trash");
    expect(roles(m)).toEqual(["inbox"]);
    expect(row(a).in_trash).toBe(0);
    expect(row(a).in_inbox).toBe(1);
  });

  it("trash on Gmail can be undone back into Inbox and All Mail", () => {
    const a = thread();
    const m = addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    const trashed = stack.services.threads.modify([a], [{ type: "trash" }], user).activity!;
    expect(roles(m)).toEqual(["trash"]);
    stack.services.activity.undo(trashed.id, user);
    expect(roles(m)).toEqual(["all", "inbox"]);
  });

  it("several actions in one call are one activity, undone in reverse", () => {
    const label = addLabel(stack.store, "Receipts");
    const a = thread();
    const m = addMessage(stack.store, gmail, { threadId: a, unread: true, in: ["inbox", "all"] });
    const act = stack.services.threads.modify(
      [a],
      [{ type: "addLabels", labelIds: [label] }, { type: "archive" }, { type: "markRead" }],
      user,
    ).activity!;
    expect(act.summary).toBe("Labeled 1 conversation Receipts, archived them and marked them as read");
    stack.services.activity.undo(act.id, user);
    expect(roles(m)).toEqual(["all", "inbox"]);
    expect(stack.store.messages.get(m)!.unread).toBe(true);
    expect(stack.store.messages.labels([m])).toEqual([]);
  });

  it("changes nothing and records nothing when there is nothing to do", () => {
    const a = thread();
    addMessage(stack.store, gmail, { threadId: a, in: ["all"] });
    expect(stack.services.threads.modify([a], [{ type: "archive" }], user).activity).toBeNull();
  });

  it("publishes invalidations and the activity", () => {
    const a = thread();
    addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    stack.events.length = 0;
    stack.services.threads.modify([a], [{ type: "star" }], user);
    const kinds = stack.events.map((e) => e.type);
    expect(kinds).toContain("invalidate");
    expect(kinds).toContain("activity");
  });

  it("label delete removes it everywhere and undo brings it back on the same messages", () => {
    const label = addLabel(stack.store, "Travel");
    const a = thread();
    const m = addMessage(stack.store, gmail, { threadId: a, labels: [label], in: ["inbox", "all"] });
    expect(stack.services.labels.delete({ labelId: label }, user)).toEqual({ removedFrom: 1 });
    expect(stack.store.labels.get(label)).toBeNull();
    expect(stack.store.threads.labelIds([a]).get(a)).toEqual([]);
    const entry = stack.services.activity.list({}).items[0]!;
    expect(entry.summary).toBe("Deleted the label Travel (it was on 1 conversation)");
    stack.services.activity.undo(entry.id, user);
    expect(stack.store.labels.get(label)?.name).toBe("Travel");
    expect(stack.store.messages.labels([m]).map((l) => l.labelId)).toEqual([label]);
  });
});

describe("refreshThreads", () => {
  it("aggregates unread, labels, inbox and participants from the messages", () => {
    const l1 = addLabel(stack.store, "A");
    const l2 = addLabel(stack.store, "B");
    const a = thread();
    addMessage(stack.store, gmail, { threadId: a, from: { name: "Ann", address: "ann@x.test" }, unread: true, labels: [l1], in: ["all"], at: 1000 });
    addMessage(stack.store, gmail, { threadId: a, from: { name: "Bob", address: "bob@x.test" }, unread: true, labels: [l2], in: ["inbox", "all"], at: 2000 });
    addMessage(stack.store, gmail, { threadId: a, from: { name: "Ann", address: "ANN@x.test" }, starred: true, in: ["sent", "all"], at: 3000, subject: "Re: Hello" });
    const t = stack.store.threads.summaries([a])[0]!;
    expect(t.unreadCount).toBe(2);
    expect(t.messageCount).toBe(3);
    expect(t.labelIds.sort()).toEqual([l1, l2].sort());
    expect(t.inInbox).toBe(true);
    expect(t.inSent).toBe(true);
    expect(t.starred).toBe(true);
    expect(t.subject).toBe("Re: Hello");
    expect(t.lastMessageAt).toBe(3000);
    expect(t.participants.map((p) => p.name)).toEqual(["Ann", "Bob"]);
  });

  it("a trashed message does not move the rest of the conversation", () => {
    const a = thread();
    addMessage(stack.store, imap, { threadId: a, in: ["inbox"], at: 1000 });
    addMessage(stack.store, imap, { threadId: a, in: ["trash"], at: 2000, unread: true });
    const r = row(a);
    expect(r.in_inbox).toBe(1);
    expect(r.in_trash).toBe(1);
    expect(r.live_count).toBe(1);
    expect(r.unread_count).toBe(0);
    expect(r.last_message_at).toBe(1000);
  });

  it("deletes a thread with no messages and no drafts", () => {
    const a = thread();
    const m = addMessage(stack.store, imap, { threadId: a });
    stack.store.messages.delete([m]);
    stack.store.refreshThreads([a]);
    expect(stack.store.threads.get(a)).toBeNull();
  });
});
