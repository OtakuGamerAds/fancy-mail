import { afterEach, describe, expect, it } from "vitest";

import type { DraftRecord } from "../store/types.ts";
import { buildMessage } from "../sync/smtp.ts";
import { addAccount, agent, createTestStack, user } from "../testing.ts";
import type { TestStack } from "../testing.ts";

let stack: TestStack;
afterEach(() => stack?.cleanup());

const draft = {
  mode: "new",
  to: [{ name: null, address: "friend@example.com" }],
  cc: [],
  bcc: [],
  subject: "Hi",
  bodyText: "Hello",
  threadId: null,
} as unknown as DraftRecord;

describe("account names", () => {
  it("starts the sender name as the account name, and renaming in the app leaves it alone", () => {
    stack = createTestStack();
    const { accountId } = addAccount(stack.store, { email: "anna@example.com", name: "Anna Weber" });
    expect(stack.services.accounts.get(accountId).senderName).toBe("Anna Weber");

    const renamed = stack.services.accounts.update({ accountId, displayName: "Bank" }, user);
    expect(renamed.displayName).toBe("Bank");
    expect(renamed.senderName).toBe("Anna Weber");

    const changed = stack.services.accounts.update({ accountId, senderName: "  A. Weber\n" }, user);
    expect(changed.senderName).toBe("A. Weber");
    expect(changed.displayName).toBe("Bank");
  });

  it("puts the sender name, not the name in the app, in the From line", async () => {
    stack = createTestStack();
    const { accountId } = addAccount(stack.store, { email: "anna@example.com", name: "Anna Weber" });
    stack.services.accounts.update({ accountId, displayName: "Bank" }, user);
    const built = await buildMessage({ account: stack.store.accounts.get(accountId)!, draft, source: null, files: [] });
    const from = built.raw.toString("utf8").match(/^From: (.*)$/m)?.[1];
    expect(from).toContain("Anna Weber");
    expect(from).not.toContain("Bank");
  });

  it("lets the name in the app be emptied (the app shows the address then)", () => {
    stack = createTestStack();
    const { accountId } = addAccount(stack.store, { email: "anna@example.com", name: "Anna Weber" });
    const cleared = stack.services.accounts.update({ accountId, displayName: "  " }, user);
    expect(cleared.displayName).toBe("");
    expect(cleared.senderName).toBe("Anna Weber");
    expect(stack.services.accounts.resolve("")).toBeNull();
  });

  it("only the user changes the sender name", () => {
    stack = createTestStack();
    const { accountId } = addAccount(stack.store, { email: "anna@example.com", access: "send" });
    expect(() => stack.services.accounts.update({ accountId, senderName: "Someone else" }, agent)).toThrow();
  });
});
