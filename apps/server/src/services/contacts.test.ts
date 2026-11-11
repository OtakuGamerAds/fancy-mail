import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addAccount, addMessage, agent, createTestStack, thread, user } from "../testing.ts";
import type { Built, TestStack } from "../testing.ts";

let stack: TestStack;
let me: Built;

beforeEach(() => {
  stack = createTestStack();
  me = addAccount(stack.store, { email: "me@example.test", access: "send" });
});
afterEach(() => stack.cleanup());

const ME = { name: "Me", address: "me@example.test" };
const suggest = (query: string) => stack.services.contacts.suggest({ query }, user).map((a) => a.address);

describe("address suggestions", () => {
  it("finds people by the start of a name or any part of the address, never yourself", () => {
    addMessage(stack.store, me, { threadId: thread(), from: { name: "Ahmad Khalil", address: "a.khalil@work.test" }, to: [ME] });
    addMessage(stack.store, me, { threadId: thread(), from: { name: "Sara Haddad", address: "sara@home.test" }, to: [ME] });
    addMessage(stack.store, me, { threadId: thread(), from: { name: "أحمد سمير", address: "samir@mail.test" }, to: [ME] });

    expect(suggest("ahm")).toEqual(["a.khalil@work.test"]);
    expect(suggest("khal")).toEqual(["a.khalil@work.test"]);
    expect(suggest("home")).toEqual(["sara@home.test"]);
    expect(suggest("أحمد")).toEqual(["samir@mail.test"]);
    expect(suggest("ahmad k")).toEqual(["a.khalil@work.test"]);
    expect(suggest("me@")).toEqual([]);
    expect(suggest("  ")).toEqual([]);
    expect(stack.services.contacts.suggest({ query: "sara" }, user)[0]).toEqual({ name: "Sara Haddad", address: "sara@home.test" });
  });

  it("puts people you wrote to before people who only wrote to you", () => {
    for (let i = 0; i < 3; i++) {
      addMessage(stack.store, me, { threadId: thread(), from: { name: "Dana Newsletter", address: "dana@news.test" }, to: [ME] });
    }
    addMessage(stack.store, me, { threadId: thread(), from: ME, to: [{ name: "Dana Friend", address: "dana@friend.test" }], in: ["sent"] });
    expect(suggest("dana")).toEqual(["dana@friend.test", "dana@news.test"]);
  });

  it("leaves out no-reply senders, and what agents can't see", () => {
    addMessage(stack.store, me, { threadId: thread(), from: { name: "Shop", address: "noreply@shop.test" }, to: [ME] });
    addMessage(stack.store, me, { threadId: thread(), from: { name: "Shop Team", address: "team@shop.test" }, to: [ME] });
    expect(suggest("shop")).toEqual(["team@shop.test"]);
    stack.store.accounts.update(me.accountId, { agentAccess: "none" });
    expect(stack.services.contacts.suggest({ query: "shop" }, agent)).toEqual([]);
  });
});
