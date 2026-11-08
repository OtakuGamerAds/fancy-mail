/**
 * Test helpers: a complete service stack on a temp data dir (never the user's data), and a
 * small builder for hand-made accounts and messages.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Address, AgentAccess, MailboxRole } from "@fancy-mail/contracts";

import { migrate } from "./db/migrations.ts";
import { newId } from "./db/ids.ts";
import { openDb } from "./db/sqlite.ts";
import { silentLogger } from "./log.ts";
import { createEventBus } from "./services/bus.ts";
import type { CallContext } from "./services/context.ts";
import { createServices } from "./services/index.ts";
import type { Services } from "./services/index.ts";
import { createVault } from "./services/vault.ts";
import { createStore } from "./store/index.ts";
import type { Store } from "./store/index.ts";
import type { MailboxRecord } from "./store/types.ts";
import { createLocalOnlySync } from "./sync/localOnly.ts";

export const TEST_NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

export interface TestStack {
  dir: string;
  services: Services;
  store: Store;
  events: { type: string }[];
  cleanup(): void;
}

export function createTestStack(options: { demo?: boolean; now?: number } = {}): TestStack {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-test-"));
  const db = openDb(path.join(dir, "mail.db"));
  migrate(db);
  const store = createStore(db);
  const bus = createEventBus();
  const log = silentLogger();
  const now = options.now ?? TEST_NOW;
  const services = createServices({ db, store, bus, vault: createVault(db, Buffer.alloc(32, 7)), log, dataDir: dir, version: "test", now: () => now });
  const sync = createLocalOnlySync({
    db,
    store,
    services,
    bus,
    vault: services.vault,
    log,
    config: { dataDir: dir, port: 0, host: "127.0.0.1", webDist: null, dev: false, vaultKey: Buffer.alloc(32, 7), seedDemo: false, sessionToken: null, version: "test" },
  });
  services.attachSync(sync);
  const events: { type: string }[] = [];
  bus.subscribe((e) => events.push(e));
  if (options.demo) services.demo.seed({ now });
  return {
    dir,
    services,
    store,
    events,
    cleanup() {
      void sync.stop();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const user: CallContext = { actor: { kind: "user" } };
export const agent: CallContext = { actor: { kind: "agent", name: "claude-code" } };

const ROLES: Record<"gmail" | "imap", { path: string; role: MailboxRole }[]> = {
  gmail: [
    { path: "INBOX", role: "inbox" },
    { path: "[Gmail]/All Mail", role: "all" },
    { path: "[Gmail]/Sent Mail", role: "sent" },
    { path: "[Gmail]/Trash", role: "trash" },
    { path: "[Gmail]/Spam", role: "spam" },
  ],
  imap: [
    { path: "INBOX", role: "inbox" },
    { path: "Sent", role: "sent" },
    { path: "Trash", role: "trash" },
    { path: "Junk", role: "spam" },
  ],
};

export interface Built {
  accountId: string;
  boxes: Map<MailboxRole, MailboxRecord>;
}

/** An account with standard mailboxes (IMAP style has no Archive, so archiving creates one). */
export function addAccount(
  store: Store,
  input: { email: string; name?: string; style?: "gmail" | "imap"; access?: AgentAccess; groupId?: string | null },
): Built {
  const accountId = newId("acc");
  store.accounts.insert({
    id: accountId,
    email: input.email,
    displayName: input.name ?? input.email.split("@")[0]!,
    username: input.email,
    provider: "imap",
    authKind: "password",
    groupId: input.groupId ?? null,
    color: "#3b82f6",
    sortOrder: 0,
    agentAccess: input.access ?? "organize",
    signature: "",
    imap: null,
    smtp: null,
    status: { state: "ready", message: null, lastSyncAt: null, progress: null },
    paused: false,
    isDemo: false,
    createdAt: TEST_NOW,
  });
  const boxes = new Map<MailboxRole, MailboxRecord>();
  for (const r of ROLES[input.style ?? "imap"]) {
    const mb: MailboxRecord = {
      id: newId("mbx"),
      accountId,
      path: r.path,
      name: r.path,
      role: r.role,
      delimiter: "/",
      specialUse: null,
      uidvalidity: 1,
      uidnext: 1,
      highestmodseq: null,
      sync: null,
      selectable: true,
      createdLocally: false,
    };
    store.mailboxes.insert(mb);
    boxes.set(r.role, mb);
  }
  return { accountId, boxes };
}

let uid = 1;

/** One message in a thread, in the given mailboxes. Returns the message id. */
export function addMessage(
  store: Store,
  built: Built,
  input: {
    threadId: string;
    subject?: string;
    from?: Address;
    to?: Address[];
    text?: string;
    at?: number;
    unread?: boolean;
    starred?: boolean;
    in?: MailboxRole[];
    labels?: string[];
    attachment?: string;
    size?: number;
  },
): string {
  const id = newId("msg");
  store.messages.insert({
    id,
    accountId: built.accountId,
    threadId: input.threadId,
    remoteId: `<${id}@test>`,
    gmThreadId: null,
    messageIdHeader: `<${id}@test>`,
    inReplyTo: null,
    references: [],
    subject: input.subject ?? "Hello",
    from: input.from ?? { name: "Someone", address: "someone@example.test" },
    to: input.to ?? [{ name: null, address: "me@example.test" }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: input.at ?? TEST_NOW - 3_600_000,
    snippet: (input.text ?? "").slice(0, 200),
    size: input.size ?? 1000,
    unread: input.unread ?? false,
    starred: input.starred ?? false,
    isDraft: false,
    hasAttachments: Boolean(input.attachment),
    bodyState: "ready",
  });
  for (const role of input.in ?? ["inbox"]) {
    const box = built.boxes.get(role);
    if (box) store.messages.addLocation(id, box.id, uid++);
  }
  for (const labelId of input.labels ?? []) store.messages.addLabel(id, labelId);
  if (input.attachment) {
    store.messages.insertAttachment({
      id: newId("att"),
      messageId: id,
      part: "2",
      filename: input.attachment,
      mimeType: "application/pdf",
      size: 100,
      contentId: null,
      inline: false,
      localPath: null,
    });
  }
  store.messages.setBody(id, { text: input.text ?? "", html: null });
  store.refreshThreads([input.threadId]);
  return id;
}

export function addLabel(store: Store, name: string): string {
  const id = newId("lbl");
  store.labels.insert({ id, name, color: null, sortOrder: store.labels.nextSortOrder(), createdAt: TEST_NOW });
  return id;
}

export function thread(): string {
  return newId("thr");
}
