import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFAULT_SETTINGS,
  agentAccessAllows,
  type Account,
  type Activity,
  type Actor,
  type AgentAccess,
  type AiSummary,
  type Draft,
  type Label,
  type ModifyAction,
  type ThreadSummary,
} from "@fancy-mail/contracts";
import { describe, expect, it } from "vitest";

import type { McpMailApi } from "./api.ts";
import { buildMcpServer } from "./tools.ts";

function account(id: string, email: string, agentAccess: AgentAccess): Account {
  return {
    id,
    email,
    displayName: email.split("@")[0]!,
    senderName: email.split("@")[0]!,
    provider: "demo",
    authKind: "none",
    groupId: null,
    color: "#3b82f6",
    sortOrder: 0,
    agentAccess,
    signature: "",
    imap: null,
    smtp: null,
    status: { state: "ready", message: null, lastSyncAt: 0, progress: null },
    unreadInboxCount: 1,
    createdAt: 0,
  };
}

function thread(id: string, accountId: string, subject: string): ThreadSummary {
  return {
    id,
    accountId,
    subject,
    snippet: "Rechnung im Anhang",
    participants: [{ name: "AdPilot", address: "billing@adpilot.example" }],
    lastMessageAt: new Date(2026, 9, 3, 14, 5).getTime(),
    messageCount: 1,
    unreadCount: 1,
    starred: false,
    hasAttachments: true,
    labelIds: [],
    inInbox: true,
    inSent: false,
    inTrash: false,
    inSpam: false,
    draftCount: 0,
    liveCount: 1,
    category: null,
  };
}

/** A tiny in-memory stand-in for the app, enforcing access the way the services do. */
function fakeApi(levels: { business: AgentAccess; bank: AgentAccess }) {
  const accounts = [account("acc_b", "billing@studio.example", levels.business), account("acc_k", "bank@mail.example", levels.bank)];
  const threads = [thread("thr_1", "acc_b", "Invoice 2026-10"), thread("thr_2", "acc_b", "Invoice 2026-09"), thread("thr_3", "acc_k", "Kontoauszug")];
  const labels: Label[] = [];
  const activity: Activity[] = [];
  const drafts: Draft[] = [];
  const summaries = new Map<string, AiSummary>();
  const access = (accountId: string) => accounts.find((a) => a.id === accountId)!.agentAccess;
  const need = (accountId: string, level: AgentAccess, actor: Actor) => {
    if (actor.kind === "agent" && !agentAccessAllows(access(accountId), level)) {
      throw new Error(`${accounts.find((a) => a.id === accountId)!.email} allows agents to ${access(accountId)} only.`);
    }
  };
  const visible = () => threads.filter((t) => access(t.accountId) !== "none");
  const calls: { modify: { threadIds: string[]; actions: ModifyAction[] }[] } = { modify: [] };

  const api: McpMailApi = {
    settings: () => DEFAULT_SETTINGS,
    accounts: () => accounts,
    groups: () => [],
    labels: () => labels,
    search: ({ query }) => {
      const ids = [...query.matchAll(/thread:(\S+)/g)].map((m) => m[1]);
      const matches = visible().filter((t) =>
        ids.length ? ids.includes(t.id) : !query.includes("Invoice") || t.subject.includes("Invoice"),
      );
      return { threads: matches, nextCursor: null, total: matches.length, queryErrors: [] };
    },
    getThread: (threadId) => {
      const t = visible().find((x) => x.id === threadId);
      if (!t) throw new Error(`No conversation with id ${threadId}.`);
      return {
        thread: t,
        drafts: drafts.filter((d) => d.threadId === threadId),
        summary: summaries.get(threadId) ?? null,
        messages: [
          {
            id: "msg_1",
            threadId,
            accountId: t.accountId,
            messageIdHeader: "<1@adpilot.example>",
            inReplyTo: null,
            references: [],
            from: { name: "AdPilot", address: "billing@adpilot.example" },
            to: [{ name: null, address: "billing@studio.example" }],
            cc: [],
            bcc: [],
            replyTo: [],
            subject: t.subject,
            date: t.lastMessageAt,
            snippet: t.snippet,
            unread: true,
            starred: false,
            isDraft: false,
            labelIds: [],
            attachments: [],
            body: { text: `Hello,\n\n${"Please find the invoice attached. ".repeat(40)}\n\n> old quoted text`, html: null },
          },
        ],
      };
    },
    ensureBodies: async () => {},
    setSummary: (threadId, text, actor) => {
      need(threads.find((t) => t.id === threadId)!.accountId, "organize", actor);
      if (!text.trim()) {
        summaries.delete(threadId);
        return { summary: null };
      }
      const summary = { text: text.trim(), by: actor, at: new Date(2026, 9, 4, 8, 0).getTime() };
      summaries.set(threadId, summary);
      return { summary };
    },
    modify: (threadIds, actions, actor) => {
      for (const id of threadIds) need(threads.find((t) => t.id === id)!.accountId, "organize", actor);
      calls.modify.push({ threadIds, actions });
      const entry: Activity = { id: `act_${activity.length + 1}`, at: 0, actor, summary: `Changed ${threadIds.length} conversations`, kind: "modify", threadIds, undoable: true, undoneAt: null };
      activity.unshift(entry);
      return { activity: entry };
    },
    createLabel: ({ name, color }) => {
      const label = { id: `lbl_${labels.length + 1}`, name, color, sortOrder: labels.length, threadCount: 0, unreadThreadCount: 0, byAccount: {} };
      labels.push(label);
      return label;
    },
    updateLabel: () => labels[0]!,
    deleteLabel: () => {},
    createGroup: () => ({ id: "grp_1", name: "x", color: "#000", sortOrder: 0, collapsed: false, unreadInboxCount: 0 }),
    updateGroup: () => ({ id: "grp_1", name: "x", color: "#000", sortOrder: 0, collapsed: false, unreadInboxCount: 0 }),
    deleteGroup: () => {},
    reorderGroups: () => {},
    assignAccounts: () => {},
    attachment: async () => {
      throw new Error("No attachment.");
    },
    drafts: () => drafts,
    saveDraft: (input, actor) => {
      need(input.accountId, "draft", actor);
      const draft: Draft = { ...input, id: input.id ?? `drf_${drafts.length + 1}`, conversationId: input.threadId ?? `thr_new_${drafts.length + 1}`, createdBy: actor, updatedAt: 0, sendState: "draft", sendError: null, sendAt: null };
      drafts.push(draft);
      return draft;
    },
    deleteDraft: () => {},
    sendDraft: () => drafts[0]!,
    activity: (limit) => activity.slice(0, limit),
    undo: (id) => {
      const entry = activity.find((a) => a.id === id)!;
      entry.undoneAt = 1;
      return entry;
    },
  };
  return { api, calls, drafts, summaries };
}

async function connect(api: McpMailApi) {
  const server = buildMcpServer(api, () => ({ kind: "agent", name: "claude-code" }), "test");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
  };
  return { client, call };
}

describe("MCP tools", () => {
  it("lists only the tools the access levels allow", async () => {
    const read = await connect(fakeApi({ business: "read", bank: "read" }).api);
    const readTools = (await read.client.listTools()).tools.map((t) => t.name);
    expect(readTools).toContain("mail_search");
    expect(readTools).not.toContain("mail_organize");
    expect(readTools).not.toContain("mail_draft");
    expect(readTools).not.toContain("mail_send_draft");

    const draft = await connect(fakeApi({ business: "draft", bank: "read" }).api);
    const draftTools = (await draft.client.listTools()).tools.map((t) => t.name);
    expect(draftTools).toEqual(expect.arrayContaining(["mail_organize", "mail_draft"]));
    expect(draftTools).not.toContain("mail_send_draft");
    expect(readTools).not.toContain("mail_summary");
    expect(draftTools).toContain("mail_summary");
  });

  it("writes a summary the conversation then shows, and removes it", async () => {
    const fake = fakeApi({ business: "organize", bank: "read" });
    const { call } = await connect(fake.api);
    const set = await call("mail_summary", { thread_id: "thr_1", summary: "AdPilot's October invoice.\n- Pay by Oct 17" });
    expect(set.isError).toBe(false);
    expect(fake.summaries.get("thr_1")).toMatchObject({ text: "AdPilot's October invoice.\n- Pay by Oct 17", by: { kind: "agent", name: "claude-code" } });
    const read = await call("mail_read_thread", { thread_id: "thr_1" });
    expect(read.text).toContain("Summary shown above it (by claude-code, 2026-10-04 08:00):\nAdPilot's October invoice.");
    const cleared = await call("mail_summary", { thread_id: "thr_1", summary: "" });
    expect(cleared.text).toBe("thr_1 has no summary now.");
    expect(fake.summaries.has("thr_1")).toBe(false);
    const readOnly = await call("mail_summary", { thread_id: "thr_3", summary: "Statement" });
    expect(readOnly.isError).toBe(true);
  });

  it("hides accounts with no access from the overview and search", async () => {
    const { call } = await connect(fakeApi({ business: "organize", bank: "none" }).api);
    expect((await call("mail_overview")).text).not.toContain("bank@mail.example");
    expect((await call("mail_search", { query: "in:inbox" })).text).not.toContain("thr_3");
  });

  it("gives search results with ids, people and subjects", async () => {
    const { call } = await connect(fakeApi({ business: "organize", bank: "read" }).api);
    const { text } = await call("mail_search", { query: "Invoice" });
    expect(text).toContain("2 of 2 conversations");
    expect(text).toContain("thr_1 | 2026-10-03 14:05 | billing@studio.example | AdPilot <billing@adpilot.example> | Invoice 2026-10 | unread,📎");
  });

  it("reads a conversation as untrusted text without its quotes, and says how to read more", async () => {
    const { call } = await connect(fakeApi({ business: "read", bank: "read" }).api);
    const { text } = await call("mail_read_thread", { thread_id: "thr_1", max_chars_per_message: 300 });
    expect(text).toContain('<email_body untrusted="true">');
    expect(text).not.toContain("old quoted text");
    expect(text).toMatch(/more characters — call again with max_chars_per_message: \d+/);
  });

  it("organizes everything a query matches, creating the label, and can be undone", async () => {
    const fake = fakeApi({ business: "organize", bank: "read" });
    const { call } = await connect(fake.api);
    const result = await call("mail_organize", { query: "Invoice", actions: [{ type: "add_labels", labels: ["Invoices"] }, { type: "archive" }] });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Created label: Invoices.");
    expect(fake.calls.modify[0]).toEqual({
      threadIds: ["thr_1", "thr_2"],
      actions: [{ type: "addLabels", labelIds: ["lbl_1"] }, { type: "archive" }],
    });
    const undo = await call("mail_activity", { action: "undo", activity_id: "act_1" });
    expect(undo.text).toBe("Undone: Changed 2 conversations.");
  });

  it("leaves conversations of read-only accounts alone, by id too, and says which", async () => {
    const fake = fakeApi({ business: "organize", bank: "read" });
    const { call } = await connect(fake.api);
    const only = await call("mail_organize", { thread_ids: ["thr_3"], actions: [{ type: "archive" }] });
    expect(only.text).toContain("Every match is in an account you may only read (1 in bank@mail.example). Nothing was changed");
    const mixed = await call("mail_organize", { thread_ids: ["thr_1", "thr_3", "thr_x"], actions: [{ type: "archive" }] });
    expect(fake.calls.modify).toEqual([{ threadIds: ["thr_1"], actions: [{ type: "archive" }] }]);
    expect(mixed.text).toContain("Skipped 1 in bank@mail.example");
    expect(mixed.text).toContain("Not found (left alone): thr_x.");
  });

  it("reports what a dry run would change without changing it", async () => {
    const fake = fakeApi({ business: "organize", bank: "read" });
    const { call } = await connect(fake.api);
    const result = await call("mail_organize", { query: "Invoice", actions: [{ type: "archive" }], dry_run: true });
    expect(result.text).toContain("Would change 2 conversations (nothing was changed — dry run).");
    expect(fake.calls.modify).toHaveLength(0);
  });

  it("organizes a query across accounts, skipping the ones it may only read", async () => {
    const fake = fakeApi({ business: "organize", bank: "read" });
    const { call } = await connect(fake.api);
    const result = await call("mail_organize", { query: "in:inbox", actions: [{ type: "mark_read" }] });
    expect(result.isError).toBe(false);
    expect(fake.calls.modify[0]?.threadIds).toEqual(["thr_1", "thr_2"]);
    expect(result.text).toContain("Skipped 1 in bank@mail.example: you may only read that account.");
  });

  it("refuses a query that matches more than max_threads", async () => {
    const fake = fakeApi({ business: "organize", bank: "organize" });
    const { call } = await connect(fake.api);
    const result = await call("mail_organize", { query: "in:inbox", max_threads: 2, actions: [{ type: "archive" }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("3 conversations match");
    expect(fake.calls.modify).toHaveLength(0);
  });

  it("drafts a reply to the sender in the conversation, by the agent", async () => {
    const fake = fakeApi({ business: "draft", bank: "read" });
    const { call } = await connect(fake.api);
    const result = await call("mail_draft", { action: "create", reply_to_thread_id: "thr_1", body: "Danke, ist bezahlt." });
    expect(result.isError).toBe(false);
    expect(fake.drafts[0]).toMatchObject({
      accountId: "acc_b",
      mode: "reply",
      threadId: "thr_1",
      subject: "Re: Invoice 2026-10",
      to: [{ name: "AdPilot", address: "billing@adpilot.example" }],
      createdBy: { kind: "agent", name: "claude-code" },
    });
  });
});
