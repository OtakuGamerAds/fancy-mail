import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addAccount, addMessage, agent, createTestStack, TEST_NOW, thread, user } from "../testing.ts";
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

describe("conversation summaries", () => {
  it("keeps what an agent wrote, shows it with the conversation, finds it, and removes it", () => {
    const a = thread();
    const b = thread();
    addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    addMessage(stack.store, gmail, { threadId: b, in: ["inbox", "all"] });

    const { summary } = stack.services.threads.setSummary(a, "  The venue moved.\r\n- Confirm by Friday  ", agent);
    expect(summary).toEqual({ text: "The venue moved.\n- Confirm by Friday", by: agent.actor, at: TEST_NOW });
    expect(stack.services.threads.get(a, user).summary).toEqual(summary);
    expect(stack.services.threads.get(b, user).summary).toBeNull();
    expect(stack.events).toContainEqual({ type: "invalidate", topics: ["threads"], threadIds: [a] });

    expect(ids("has:summary")).toEqual([a]);
    expect(ids("in:inbox -has:summary")).toEqual([b]);
    // Not an Activity entry: a morning of summaries would bury the real changes.
    expect(stack.services.activity.list({}).items).toHaveLength(0);

    stack.services.threads.setSummary(a, null, user);
    expect(stack.services.threads.get(a, user).summary).toBeNull();
    expect(ids("has:summary")).toEqual([]);
  });

  it("needs organize access, and keeps summaries short", () => {
    const reader = addAccount(stack.store, { email: "read@mail.test", access: "read" });
    const a = thread();
    const r = thread();
    addMessage(stack.store, gmail, { threadId: a, in: ["inbox", "all"] });
    addMessage(stack.store, reader, { threadId: r, in: ["inbox", "all"] });
    expect(() => stack.services.threads.setSummary(r, "Hi", agent)).toThrow(/needs "/);
    expect(() => stack.services.threads.setSummary(a, "x".repeat(4001), agent)).toThrow(/keep it short/);
    expect(stack.services.threads.get(a, user).summary).toBeNull();
  });
});
