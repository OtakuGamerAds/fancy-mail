import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addAccount, createTestStack, user } from "../testing.ts";
import type { Built, TestStack } from "../testing.ts";

let stack: TestStack;
let me: Built;

beforeEach(() => {
  stack = createTestStack();
  me = addAccount(stack.store, { email: "me@example.test", access: "send" });
});
afterEach(() => stack.cleanup());

describe("searching asks the mail servers too", () => {
  it("passes the words and from:/subject: on, but not for list views", () => {
    const ask = vi.spyOn(stack.services.env.sync(), "searchServer");
    stack.services.threads.search({ query: "in:inbox" }, user);
    expect(ask).not.toHaveBeenCalled();

    stack.services.threads.search({ query: 'invoice from:ahmad subject:"rent march" -spam is:unread' }, user);
    expect(ask).toHaveBeenCalledWith({ text: 'invoice from:ahmad subject:"rent march"', accountIds: [me.accountId] });

  });
});
