import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addAccount, agent, createTestStack, user } from "../testing.ts";
import type { TestStack } from "../testing.ts";

let stack: TestStack;
let accountId: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  stack = createTestStack();
  accountId = addAccount(stack.store, { email: "me@x.test", access: "send" }).accountId;
});

afterEach(() => {
  stack.cleanup();
  vi.useRealTimers();
});

function draft(): string {
  return stack.services.drafts.save(
    {
      accountId,
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
  ).id;
}

const sentLogged = () => stack.services.activity.list({}).items.some((a) => a.summary.startsWith("Sent "));

describe("undo send", () => {
  it("waits the set time, then goes out", () => {
    const id = draft();
    const queued = stack.services.drafts.send(id, user, { undoable: true });
    expect(queued.sendState).toBe("queued");
    expect(queued.sendAt).toBe(Date.now() + 15_000);
    expect(stack.services.drafts.get(id, user).sendAt).toBe(queued.sendAt);

    vi.advanceTimersByTime(14_000);
    expect(sentLogged()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(sentLogged()).toBe(true);
    expect(stack.store.drafts.get(id)!.sendState).not.toBe("draft");
  });

  it("Undo makes it a draft again, and nothing goes out", () => {
    const id = draft();
    stack.services.drafts.send(id, user, { undoable: true });
    vi.advanceTimersByTime(5_000);
    const back = stack.services.drafts.cancelSend(id, user);
    expect(back.sendState).toBe("draft");
    expect(back.sendAt).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(sentLogged()).toBe(false);
    expect(stack.store.drafts.get(id)!.sendState).toBe("draft");
  });

  it("Send now doesn't wait", () => {
    const id = draft();
    stack.services.drafts.send(id, user, { undoable: true });
    stack.services.drafts.sendNow(id, user);
    expect(sentLogged()).toBe(true);
    expect(() => stack.services.drafts.cancelSend(id, user)).toThrow(/already on its way/);
  });

  it("follows the setting, and 0 sends at once", () => {
    stack.services.settings.update({ undoSendSeconds: 0 }, user);
    const id = draft();
    expect(stack.services.drafts.send(id, user, { undoable: true }).sendAt).toBeNull();
    expect(sentLogged()).toBe(true);
  });

  it("agents send at once", () => {
    const id = draft();
    expect(stack.services.drafts.send(id, agent, { undoable: true }).sendAt).toBeNull();
    expect(sentLogged()).toBe(true);
  });

  it("after a restart, a waiting send is a draft again and a cut-off one is marked", () => {
    const waitingId = draft();
    const midSendId = draft();
    stack.store.drafts.setSendState(waitingId, "queued", null);
    stack.store.drafts.setSendState(midSendId, "sending", null);
    stack.services.drafts.recoverInterrupted();
    expect(stack.store.drafts.get(waitingId)!.sendState).toBe("draft");
    expect(stack.store.drafts.get(midSendId)!.sendState).toBe("failed");
    expect(stack.store.drafts.get(midSendId)!.sendError).toMatch(/Check Sent/);
  });
});
