import { RPC_METHODS } from "@fancy-mail/contracts";
import type { RpcMethod } from "@fancy-mail/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { silentLogger } from "../log.ts";
import { createTestStack, user } from "../testing.ts";
import type { TestStack } from "../testing.ts";
import { dispatch, rpcHandlers } from "./ws.ts";

let stack: TestStack;
let id = 0;

beforeAll(() => {
  stack = createTestStack({ demo: true });
});
afterAll(() => stack.cleanup());

/** Calls a method like a client would; checks the result against its contract schema. */
async function call(method: string, params: unknown = {}): Promise<any> {
  const response = await dispatch(rpcHandlers(stack.services), { id: ++id, method, params }, user, silentLogger());
  if (!response) throw new Error("no response");
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  const check = RPC_METHODS[method as RpcMethod].result.safeParse(response.result);
  if (!check.success) throw new Error(`${method} result breaks its contract: ${JSON.stringify(check.error.issues[0])}`);
  return response.result;
}

describe("WebSocket RPC", () => {
  it("answers every read method in the contract's shape", async () => {
    const boot = await call("app.bootstrap");
    expect(boot.accounts.length).toBe(11);
    const page = await call("threads.search", { query: "in:inbox", limit: 10 });
    await call("threads.get", { threadId: page.threads[0].id });
    await call("threads.fetchBodies", { threadId: page.threads[0].id });
    await call("activity.list", { limit: 5 });
    await call("drafts.list");
    await call("mcp.info");
    expect((await call("accounts.detect", { email: "someone@gmail.com" })).presetId).toBe("gmail");
    expect((await call("accounts.detect", { email: "alex@studio-firma.de" })).imap.host).toBe("imap.studio-firma.de");
  });

  it("runs the write methods and their undo", async () => {
    const page = await call("threads.search", { query: "in:inbox", limit: 3 });
    const ids = page.threads.map((t: { id: string }) => t.id);
    const { activity } = await call("threads.modify", { threadIds: ids, actions: [{ type: "archive" }] });
    expect(activity.summary).toBe("Archived 3 conversations");
    expect((await call("activity.undo", { activityId: activity.id })).undoneAt).not.toBeNull();

    const label = await call("labels.create", { name: "Clients", color: "#3b82f6" });
    await call("labels.update", { labelId: label.id, name: "Kunden" });
    await call("labels.reorder", { labelIds: [label.id] });
    await call("labels.delete", { labelId: label.id });

    const group = await call("groups.create", { name: "Clients" });
    await call("groups.update", { groupId: group.id, collapsed: true });
    await call("groups.reorder", { groupIds: [group.id] });
    const account = (await call("app.bootstrap")).accounts[0];
    await call("accounts.update", { accountId: account.id, groupId: group.id, displayName: "Studio (renamed)" });
    await call("accounts.reorder", { accountIds: [account.id] });
    await call("groups.delete", { groupId: group.id });
    expect((await call("app.bootstrap")).accounts.find((a: { id: string }) => a.id === account.id).groupId).toBeNull();

    const draft = await call("drafts.save", {
      draft: {
        accountId: account.id,
        mode: "new",
        threadId: null,
        sourceMessageId: null,
        to: [{ name: null, address: "someone@example.test" }],
        cc: [],
        bcc: [],
        subject: "Hi",
        bodyText: "Hello",
        attachments: [],
      },
    });
    await call("drafts.get", { draftId: draft.id });
    await call("drafts.delete", { draftId: draft.id });

    const settings = await call("settings.update", { patch: { density: "compact" } });
    expect(settings.density).toBe("compact");
    const before = (await call("mcp.info")).token;
    expect((await call("mcp.rotateToken")).token).not.toBe(before);
  });

  it("maps errors to codes and sentences", async () => {
    await expect(call("threads.get", { threadId: "thr_missing" })).rejects.toMatchObject({ code: "not_found" });
    await expect(call("threads.get", {})).rejects.toMatchObject({ code: "bad_request" });
    await expect(call("no.such.method")).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      call("accounts.addWithPassword", {
        email: "me@example.test",
        displayName: "Me",
        password: "secret",
        provider: "imap",
        imap: { host: "imap.example.test", port: 993, secure: true },
        smtp: { host: "smtp.example.test", port: 465, secure: true },
      }),
    ).rejects.toMatchObject({ code: "connection_failed" });
    await expect(call("labels.create", { name: "Invoices" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("sends a demo draft into its thread", async () => {
    const thread = (await call("threads.search", { query: 'label:"Taxes 2026"', limit: 1 })).threads[0];
    const detail = await call("threads.get", { threadId: thread.id });
    const last = detail.messages.at(-1);
    const draft = await call("drafts.save", {
      draft: {
        accountId: thread.accountId,
        mode: "reply",
        threadId: thread.id,
        sourceMessageId: last.id,
        to: [last.from],
        cc: [],
        bcc: [],
        subject: `AW: ${thread.subject}`,
        bodyText: "Danke!",
        attachments: [],
      },
    });
    const sent = new Promise<{ ok: boolean }>((resolve) => {
      const off = stack.services.bus.subscribe((e) => {
        if (e.type === "draftSent" && e.draftId === draft.id) {
          off();
          resolve(e);
        }
      });
    });
    expect((await call("drafts.send", { draftId: draft.id })).sendState).toBe("queued");
    expect((await sent).ok).toBe(true);
    const after = await call("threads.get", { threadId: thread.id });
    expect(after.messages).toHaveLength(detail.messages.length + 1);
    expect(after.messages.at(-1).body.text).toContain("Danke!");
    expect(after.drafts.some((d: { id: string }) => d.id === draft.id)).toBe(false);
    expect((await call("threads.search", { query: `thread:${thread.id} in:sent` })).total).toBe(1);
  });
});
