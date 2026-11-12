import { findSettledLabel } from "@fancy-mail/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addAccount, addMessage, createTestStack, thread, user } from "../testing.ts";
import type { Built, TestStack } from "../testing.ts";

let stack: TestStack;
let gmail: Built;

beforeEach(() => {
  stack = createTestStack();
  gmail = addAccount(stack.store, { email: "me@gmail.test", style: "gmail" });
});
afterEach(() => stack.cleanup());

const ids = (query: string) =>
  stack.services.threads
    .search({ query }, user)
    .threads.map((t) => t.id)
    .sort();
const settledLabel = () => findSettledLabel(stack.store.labels.list());

describe("settle", () => {
  it("labels every message Settled and reads it, keeps it in the inbox, and undoes", () => {
    const a = thread();
    const b = thread();
    const m1 = addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"], unread: true });
    const m2 = addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"], unread: true });
    addMessage(stack.store, gmail, { threadId: b, in: ["inbox", "all"] });
    expect(ids("is:settled")).toEqual([]);

    const { activity } = stack.services.threads.modify([a], [{ type: "settle" }], user);
    expect(activity?.summary).toBe("Settled 1 conversation");
    const label = settledLabel()!;
    expect(label.name).toBe("Settled");
    const labeled = stack.store.messages.labels([m1, m2]).filter((l) => l.labelId === label.id);
    expect(labeled).toHaveLength(2);
    expect(stack.store.threads.get(a)!.in_inbox).toBe(1);
    expect(stack.store.threads.get(a)!.unread_count).toBe(0);
    expect(ids("is:settled")).toEqual([a]);
    expect(ids("in:inbox is:unsettled")).toEqual([b]);
    expect(ids("in:inbox -is:settled")).toEqual([b]);

    stack.services.activity.undo(activity!.id, user);
    expect(ids("is:settled")).toEqual([]);
    expect(stack.store.threads.get(a)!.unread_count).toBe(2);
  });

  it("sends the label to Gmail", () => {
    const a = thread();
    addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    stack.services.threads.modify([a], [{ type: "settle" }], user);
    const ops = stack.store.outbox.pending(gmail.accountId);
    const changes = ops.flatMap((op) => (op.payload as { changes: { addLabels: string[] }[] }).changes);
    expect(changes.some((c) => c.addLabels.includes("Settled"))).toBe(true);
  });

  it("un-settles quietly when new mail comes", () => {
    const a = thread();
    addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    stack.services.threads.modify([a], [{ type: "settle" }], user);
    const before = stack.services.activity.list({}).items.length;
    stack.services.threads.unsettle([a]);
    expect(ids("is:settled")).toEqual([]);
    expect(stack.services.activity.list({}).items.length).toBe(before);
  });

  it("keeps the name for itself", () => {
    expect(() => stack.services.labels.create({ name: "settled" }, user)).toThrow(/kept for settled conversations/);
    const a = thread();
    addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    stack.services.threads.modify([a], [{ type: "settle" }], user);
    const label = settledLabel()!;
    expect(() => stack.services.labels.update({ labelId: label.id, name: "Done" }, user)).toThrow(/Fancy Mail's own label/);
    expect(() => stack.services.labels.delete({ labelId: label.id }, user)).toThrow(/Fancy Mail's own label/);
    expect(stack.services.labels.ensure("Settled", user).id).toBe(label.id);
  });
});
