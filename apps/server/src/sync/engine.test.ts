import net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccountStatus, ServerEvent } from "@fancy-mail/contracts";

import { silentLogger } from "../log.ts";
import { createTestStack, user } from "../testing.ts";
import type { TestStack } from "../testing.ts";
import { createSyncEngine } from "./engine.ts";
import type { SyncEngine } from "./types.ts";

let stack: TestStack;
let engine: SyncEngine;
let closedPort: number;

/** A port nothing listens on (the connection is refused right away). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function nextStatus(accountId: string, state: AccountStatus["state"]): Promise<AccountStatus> {
  return new Promise((resolve) => {
    const off = stack.services.bus.subscribe((event: ServerEvent) => {
      if (event.type === "accountStatus" && event.accountId === accountId && event.status.state === state) {
        off();
        resolve(event.status);
      }
    });
  });
}

beforeEach(async () => {
  stack = createTestStack({ demo: true });
  closedPort = await freePort();
  const env = stack.services.env;
  engine = createSyncEngine({
    db: env.db,
    store: env.store,
    services: stack.services,
    bus: env.bus,
    vault: env.vault,
    log: silentLogger(),
    config: { dataDir: stack.dir, port: 0, host: "127.0.0.1", webDist: null, dev: false, vaultKey: Buffer.alloc(32, 7), seedDemo: false, sessionToken: null, version: "test" },
  });
  stack.services.attachSync(engine);
  engine.start();
});

afterEach(async () => {
  await engine.stop();
  stack.cleanup();
});

describe("the real sync engine", () => {
  it("leaves demo accounts to the local-only engine", async () => {
    const demo = stack.store.accounts.list().find((a) => a.isDemo)!;
    stack.store.outbox.enqueue(demo.id, { kind: "labelDelete", name: "x" });
    engine.notifyOutbox(demo.id);
    expect(stack.store.outbox.pending(demo.id)).toEqual([]);
    const thread = stack.services.threads.search({ query: "has:attachment" }, user).threads[0]!;
    const detail = stack.services.threads.get(thread.id, user);
    const att = stack.store.messages.attachments(detail.messages.map((m) => m.id))[0];
    if (att?.localPath) expect(await engine.downloadAttachment(att.id)).toBe(att.localPath);
  });

  it("explains a refused connection when adding an account, and saves nothing", async () => {
    const attempt = stack.services.accounts.addWithPassword(
      {
        email: "someone@example.test",
        displayName: "Someone",
        password: "secret-password",
        provider: "imap",
        imap: { host: "127.0.0.1", port: closedPort, secure: true },
        smtp: { host: "127.0.0.1", port: closedPort, secure: true },
      },
      user,
    );
    await expect(attempt).rejects.toMatchObject({ code: "connection_failed", message: expect.stringMatching(/refused the connection/) });
    expect(stack.store.accounts.findByEmail("someone@example.test")).toBeNull();
  });

  it("goes offline (keeping the account, its password and its mail) when the server can't be reached", async () => {
    const id = "acc_offlinetest";
    stack.store.accounts.insert({
      id,
      email: "offline@example.test",
      displayName: "Offline",
      username: "offline@example.test",
      provider: "imap",
      authKind: "password",
      groupId: null,
      color: "#3b82f6",
      sortOrder: 0,
      agentAccess: "read",
      signature: "",
      imap: { host: "127.0.0.1", port: closedPort, secure: true },
      smtp: { host: "127.0.0.1", port: closedPort, secure: true },
      status: { state: "idle", message: null, lastSyncAt: null, progress: null },
      paused: false,
      isDemo: false,
      createdAt: Date.now(),
    });
    stack.services.vault.put(id, "password", "kept-password");
    const offline = nextStatus(id, "offline");
    engine.accountAdded(id);
    const status = await offline;
    expect(status.message).toBe("Can't reach 127.0.0.1 — will keep trying.");
    expect(stack.store.accounts.get(id)).not.toBeNull();
    expect(stack.services.vault.get(id, "password")).toBe("kept-password");

    // Pausing stops the retries; the state says so.
    const paused = nextStatus(id, "paused");
    stack.services.accounts.update({ accountId: id, paused: true }, user);
    await paused;
    expect(stack.store.accounts.get(id)!.status.state).toBe("paused");
  });

  it("refuses to download an attachment while the account can't connect, in words", async () => {
    const id = "acc_offlinetest2";
    stack.store.accounts.insert({
      id,
      email: "offline2@example.test",
      displayName: "Offline",
      username: "offline2@example.test",
      provider: "imap",
      authKind: "password",
      groupId: null,
      color: "#3b82f6",
      sortOrder: 0,
      agentAccess: "read",
      signature: "",
      imap: { host: "127.0.0.1", port: closedPort, secure: true },
      smtp: null,
      status: { state: "idle", message: null, lastSyncAt: null, progress: null },
      paused: false,
      isDemo: false,
      createdAt: Date.now(),
    });
    stack.services.vault.put(id, "password", "pw");
    stack.store.mailboxes.insert({ id: "mbx_off_in", accountId: id, path: "INBOX", name: "Inbox", role: "inbox" });
    stack.store.messages.insert({
      id: "msg_off",
      accountId: id,
      threadId: "thr_off",
      remoteId: "<off@x>",
      gmThreadId: null,
      messageIdHeader: "<off@x>",
      inReplyTo: null,
      references: [],
      subject: "Has a file",
      from: { name: null, address: "a@x.test" },
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      date: Date.now(),
      snippet: "",
      size: 10,
      unread: true,
      starred: false,
      isDraft: false,
      hasAttachments: true,
      bodyState: "none",
    });
    stack.store.messages.addLocation("msg_off", "mbx_off_in", 1);
    stack.store.messages.insertAttachment({ id: "att_off", messageId: "msg_off", part: "2", filename: "a.pdf", mimeType: "application/pdf", size: 1, contentId: null, inline: false, localPath: null });
    const offline = nextStatus(id, "offline");
    engine.accountAdded(id);
    await offline;
    await expect(engine.downloadAttachment("att_off")).rejects.toMatchObject({ code: "connection_failed", message: expect.stringMatching(/can't reach the mail server/) });
  });
});
