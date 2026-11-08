import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addAccount, addLabel, addMessage, createTestStack, thread, user } from "../testing.ts";
import type { Built, TestStack } from "../testing.ts";
import { decodeCursor, encodeCursor, ftsPhrase } from "./compile.ts";

let stack: TestStack;
let work: Built;
let home: Built;
const ids: Record<string, string> = {};
let invoices: string;

function search(query: string, cursor?: string, limit?: number) {
  return stack.services.threads.search({ query, cursor, limit }, user);
}
function found(query: string): string[] {
  return search(query, undefined, 500).threads.map((t) => t.id);
}

beforeEach(() => {
  stack = createTestStack();
  const { store } = stack;
  const groupId = "grp_work";
  store.groups.insert({ id: groupId, name: "Business", color: "#000000", sortOrder: 0, collapsed: false, createdAt: 0 });
  work = addAccount(store, { email: "studio@work.test", name: "Studio", groupId });
  home = addAccount(store, { email: "me@home.test", name: "Private" });
  invoices = addLabel(store, "Invoices");

  ids.invoice = thread();
  addMessage(store, work, {
    threadId: ids.invoice,
    subject: "Ihre Rechnung RE-1042",
    from: { name: "AdPilot Billing", address: "ads@adpilot.test" },
    text: "Anbei Ihre Rechnung über 119,00 €",
    attachment: "Rechnung_RE-1042.pdf",
    labels: [invoices],
    unread: true,
  });
  ids.newsletter = thread();
  addMessage(store, work, {
    threadId: ids.newsletter,
    subject: "Weekly digest",
    from: { name: "News", address: "news@digest.test" },
    to: [{ name: null, address: "ads@adpilot.test" }],
    text: "This week: invoices made easy",
    in: ["inbox"],
  });
  ids.trashed = thread();
  addMessage(store, home, { threadId: ids.trashed, subject: "Old invoice", text: "invoice", in: ["trash"] });
  ids.spam = thread();
  addMessage(store, home, { threadId: ids.spam, subject: "You won", text: "prize", in: ["spam"] });
  ids.sent = thread();
  addMessage(store, home, { threadId: ids.sent, subject: "My note", from: { name: "Me", address: "me@home.test" }, text: "note", in: ["sent"] });
});

afterEach(() => stack.cleanup());

describe("compileQuery", () => {
  it("leaves out trash and spam unless a location is asked for", () => {
    expect(found("")).not.toContain(ids.trashed);
    expect(found("")).not.toContain(ids.spam);
    expect(found("in:trash")).toEqual([ids.trashed]);
    expect(found("in:spam")).toEqual([ids.spam]);
    expect(found("in:anywhere")).toHaveLength(5);
  });

  it("matches words through the index, the last one as a prefix", () => {
    expect(found("rechnung")).toEqual([ids.invoice]);
    expect(found("rechn")).toEqual([ids.invoice]);
    expect(found("invoice")).toEqual([ids.newsletter]); // the trashed one is excluded by default
    expect(found("rechnung has:attachment")).toEqual([ids.invoice]);
    expect(found("filename:pdf")).toEqual([ids.invoice]);
    expect(found('"weekly digest"')).toEqual([ids.newsletter]);
  });

  it("matches from: against the sender only", () => {
    expect(found("from:ads@")).toEqual([ids.invoice]);
    expect(found("to:ads@adpilot.test")).toEqual([ids.newsletter]);
  });

  it("negates terms", () => {
    expect(found("-rechnung")).toEqual(expect.arrayContaining([ids.newsletter, ids.sent]));
    expect(found("-rechnung")).not.toContain(ids.invoice);
    expect(found("-label:Invoices in:inbox")).toEqual([ids.newsletter]);
    expect(found("-in:inbox")).toEqual([ids.sent]);
  });

  it("resolves labels by name or id, case-insensitively, and explains unknown ones", () => {
    expect(found("label:invoices")).toEqual([ids.invoice]);
    expect(found(`label:${invoices}`)).toEqual([ids.invoice]);
    expect(found("label:none in:inbox")).toEqual([ids.newsletter]);
    const r = search("label:Rechnungen");
    expect(r.threads).toHaveLength(0);
    expect(r.queryErrors).toEqual(['No label named "Rechnungen". Labels: Invoices.']);
  });

  it("resolves accounts by email, name or id, and groups by name or id", () => {
    expect(found("account:STUDIO@work.test")).toHaveLength(2);
    expect(found("account:Private in:anywhere")).toHaveLength(3);
    expect(found(`account:${home.accountId}`)).toEqual([ids.sent]);
    expect(found("group:business")).toHaveLength(2);
    expect(found("group:grp_work")).toHaveLength(2);
    expect(found("group:none")).toEqual([ids.sent]);
    const r = search("account:nobody@x.test");
    expect(r.threads).toHaveLength(0);
    expect(r.queryErrors[0]).toBe('No account "nobody@x.test". Accounts: studio@work.test, me@home.test.');
    expect(search("group:Banking").queryErrors[0]).toBe('No group "Banking". Groups: Business, or group:none.');
  });

  it("flags: unread, attachments, sent, archive", () => {
    expect(found("is:unread")).toEqual([ids.invoice]);
    expect(found("is:read in:inbox")).toEqual([ids.newsletter]);
    expect(found("has:attachment")).toEqual([ids.invoice]);
    expect(found("in:sent")).toEqual([ids.sent]);
    expect(found("in:archive")).toEqual([]); // sent-only conversations are not "archived"
  });

  it("sorts by Gmail's categories; mail Gmail didn't sort is Primary", () => {
    const { db } = stack.services.env;
    db.run("UPDATE messages SET category = 'promotions' WHERE thread_id = ?", ids.newsletter!);
    db.run("UPDATE messages SET category = 'primary' WHERE thread_id = ?", ids.invoice!);
    stack.store.refreshThreads([ids.newsletter!, ids.invoice!]);
    expect(found("in:inbox category:promotions")).toEqual([ids.newsletter]);
    expect(found("in:inbox category:primary")).toEqual([ids.invoice!]);
    // Primary with Promotions as a tab: everything the tabs don't take, other providers' mail too.
    expect(found("-category:promotions -category:social").sort()).toEqual([ids.invoice, ids.sent].sort());
    expect(search("in:inbox category:promotions").threads[0]!.category).toBe("promotions");
    expect(search(`thread:${ids.sent}`).threads[0]!.category).toBeNull();
  });

  it("counts only Primary in the inbox's unread count when categories are tabs", () => {
    const { db } = stack.services.env;
    expect(stack.store.accounts.unreadInboxCounts(["promotions"]).get(work.accountId)).toBe(1);
    db.run("UPDATE messages SET category = 'promotions' WHERE thread_id = ?", ids.invoice!);
    stack.store.refreshThreads([ids.invoice!]);
    expect(stack.store.accounts.unreadInboxCounts(["promotions"]).get(work.accountId)).toBeUndefined();
    expect(stack.store.accounts.unreadInboxCounts([]).get(work.accountId)).toBe(1);
  });

  it("ORs several thread: terms", () => {
    expect(found(`thread:${ids.invoice} thread:${ids.sent}`).sort()).toEqual([ids.invoice, ids.sent].sort());
  });

  it("only shows the accounts an agent may see", () => {
    stack.store.accounts.update(home.accountId, { agentAccess: "none" });
    const asAgent = stack.services.threads.search({ query: "in:anywhere" }, { actor: { kind: "agent", name: "t" } });
    expect(asAgent.threads.map((t) => t.accountId)).toEqual([work.accountId, work.accountId]);
    // Hidden accounts are not even named in errors.
    const r = stack.services.threads.search({ query: "account:me@home.test" }, { actor: { kind: "agent", name: "t" } });
    expect(r.queryErrors[0]).toBe('No account "me@home.test". Accounts: studio@work.test.');
  });

  it("pages with a cursor, newest first", () => {
    const t = thread();
    for (let i = 0; i < 7; i++) addMessage(stack.store, work, { threadId: thread(), subject: `Page ${i}`, at: 1_000_000 + i });
    void t;
    const first = search("page", undefined, 3);
    expect(first.total).toBe(7);
    expect(first.threads.map((x) => x.subject)).toEqual(["Page 6", "Page 5", "Page 4"]);
    const second = search("page", first.nextCursor!, 3);
    expect(second.threads.map((x) => x.subject)).toEqual(["Page 3", "Page 2", "Page 1"]);
    const third = search("page", second.nextCursor!, 3);
    expect(third.threads.map((x) => x.subject)).toEqual(["Page 0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("keeps cursors and FTS strings safe", () => {
    expect(decodeCursor(encodeCursor(123, "thr_a:b"))).toEqual({ at: 123, id: "thr_a:b" });
    expect(decodeCursor("garbage")).toBeNull();
    expect(ftsPhrase('a" OR "b', false)).toBe('"a OR b"');
    expect(ftsPhrase("@@@", true)).toBeNull();
    expect(() => search('"unbalanced quote AND (')).not.toThrow();
  });
});
