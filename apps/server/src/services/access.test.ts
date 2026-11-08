import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addAccount, addMessage, agent, createTestStack, thread, user } from "../testing.ts";
import type { Built, TestStack } from "../testing.ts";

let stack: TestStack;
let hidden: Built;
let reader: Built;
let drafter: Built;
let hiddenThread: string;
let readerThread: string;
let drafterThread: string;

beforeEach(() => {
  stack = createTestStack();
  hidden = addAccount(stack.store, { email: "bank@private.test", access: "none" });
  reader = addAccount(stack.store, { email: "read@only.test", access: "read" });
  drafter = addAccount(stack.store, { email: "draft@work.test", access: "draft" });
  hiddenThread = thread();
  addMessage(stack.store, hidden, { threadId: hiddenThread, subject: "Kontoauszug" });
  readerThread = thread();
  addMessage(stack.store, reader, { threadId: readerThread, subject: "Read me" });
  drafterThread = thread();
  addMessage(stack.store, drafter, { threadId: drafterThread, subject: "Draft here", from: { name: "Kim", address: "kim@x.test" } });
});
afterEach(() => stack.cleanup());

describe("agent access", () => {
  it("hides accounts with access none from search and get", () => {
    const ids = stack.services.threads.search({ query: "in:anywhere" }, agent).threads.map((t) => t.id);
    expect(ids).not.toContain(hiddenThread);
    expect(ids).toHaveLength(2);
    expect(() => stack.services.threads.get(hiddenThread, agent)).toThrow(/No conversation with id/);
    expect(stack.services.threads.get(hiddenThread, user).thread.id).toBe(hiddenThread);
    expect(stack.services.accounts.list(agent).map((a) => a.email)).not.toContain("bank@private.test");
  });

  it("refuses modify below organize, naming the account and its level", () => {
    expect(() => stack.services.threads.modify([readerThread], [{ type: "archive" }], agent)).toThrow(
      'read@only.test allows agents "Read" access, and changing conversations needs "Organize".',
    );
    // Nothing changed.
    expect(stack.store.threads.get(readerThread)!.in_inbox).toBe(1);
    expect(stack.services.threads.modify([drafterThread], [{ type: "archive" }], agent).activity?.actor).toEqual(agent.actor);
  });

  it("drafts need draft access, sending needs send access", () => {
    const input = {
      accountId: drafter.accountId,
      mode: "reply" as const,
      threadId: drafterThread,
      sourceMessageId: null,
      to: [{ name: "Kim", address: "kim@x.test" }],
      cc: [],
      bcc: [],
      subject: "Re: Draft here",
      bodyText: "Thanks!",
      attachments: [],
    };
    const draft = stack.services.drafts.save(input, agent);
    expect(draft.createdBy).toEqual(agent.actor);
    expect(stack.services.drafts.listForThread(drafterThread).map((d) => d.id)).toEqual([draft.id]);
    expect(stack.store.threads.get(drafterThread)!.draft_count).toBe(1);
    expect(stack.services.activity.list({}).items[0]!.summary).toBe("Drafted a reply to “Draft here”");

    expect(() => stack.services.drafts.send(draft.id, agent)).toThrow(/needs "Send"/);
    expect(() => stack.services.drafts.save({ ...input, accountId: reader.accountId, threadId: readerThread }, agent)).toThrow(/needs "Draft"/);
    expect(() => stack.services.drafts.save({ ...input, accountId: hidden.accountId, threadId: hiddenThread }, agent)).toThrow(/No account/);
  });

  it("never lets agents change settings, accounts or the demo", () => {
    expect(() => stack.services.settings.update({ density: "compact" }, agent)).toThrow(/Only the user/);
    expect(() => stack.services.accounts.remove({ accountId: drafter.accountId }, agent)).toThrow(/Only the user/);
    expect(() => stack.services.accounts.update({ accountId: drafter.accountId, agentAccess: "send" }, agent)).toThrow(/Only the user/);
    expect(() => stack.services.demo.remove(agent)).toThrow(/Only the user/);
    expect(() => stack.services.mcp.rotateToken(agent)).toThrow(/Only the user/);
  });

  it("label changes need organize somewhere", () => {
    stack.store.accounts.update(drafter.accountId, { agentAccess: "read" });
    expect(() => stack.services.labels.create({ name: "Agents" }, agent)).toThrow(/needs "Organize" access on at least one account/);
    stack.store.accounts.update(drafter.accountId, { agentAccess: "organize" });
    expect(stack.services.labels.create({ name: "Agents" }, agent).name).toBe("Agents");
    expect(() => stack.services.labels.create({ name: "agents" }, agent)).toThrow(/already a label/);
  });
});

describe("drafts and sending (local engine)", () => {
  it("a user draft sends into the thread and disappears", async () => {
    const draft = stack.services.drafts.save(
      {
        accountId: drafter.accountId,
        mode: "new",
        threadId: null,
        sourceMessageId: null,
        to: [{ name: null, address: "kim@x.test" }],
        cc: [],
        bcc: [],
        subject: "Hello Kim",
        bodyText: "Hi",
        attachments: [],
      },
      user,
    );
    expect(draft.threadId).toBeNull();
    expect(stack.services.threads.search({ query: "in:drafts" }, user).total).toBe(1);
    expect(() => stack.services.drafts.save({ ...draft, id: draft.id, to: [{ name: null, address: "not an address" }] }, user)).toThrow(
      /isn't an email address/,
    );
    const queued = stack.services.drafts.send(draft.id, user);
    expect(queued.sendState).toBe("queued");
    // Real accounts can't send with the local engine: the draft stays, with the reason.
    await new Promise<void>((resolve) => {
      const unsubscribe = stack.services.bus.subscribe((e) => {
        if (e.type === "draftSent") {
          unsubscribe();
          expect(e.ok).toBe(false);
          resolve();
        }
      });
    });
    expect(stack.services.drafts.get(draft.id, user).sendState).toBe("failed");
  });
});
