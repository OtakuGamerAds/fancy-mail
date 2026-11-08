import fs from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStack, user } from "../testing.ts";
import type { TestStack } from "../testing.ts";

let a: TestStack;
let b: TestStack;

beforeAll(() => {
  a = createTestStack({ demo: true });
  b = createTestStack({ demo: true });
});
afterAll(() => {
  a.cleanup();
  b.cleanup();
});

const snapshot = (s: TestStack) =>
  s.store.db.all<{ id: string; subject: string; date: number; unread: number }>("SELECT id, subject, date, unread FROM messages ORDER BY seq");

describe("demo seed", () => {
  it("is deterministic", () => {
    expect(snapshot(a)).toEqual(snapshot(b));
    expect(a.store.db.all("SELECT id FROM threads ORDER BY id")).toEqual(b.store.db.all("SELECT id FROM threads ORDER BY id"));
  });

  it("is complete: every group has mail, labels are used, drafts and activity exist", () => {
    const boot = a.services.bootstrap();
    expect(boot.hasDemoData).toBe(true);
    expect(boot.accounts).toHaveLength(11);
    expect(boot.groups.map((g) => g.name)).toEqual(["Business", "Channels", "Banking", "Personal"]);
    for (const g of boot.groups) expect(a.services.threads.search({ query: `group:${g.id}` }, user).total).toBeGreaterThan(0);
    for (const l of boot.labels) expect(l.threadCount).toBeGreaterThan(0);
    const total = a.services.threads.search({ query: "in:anywhere" }, user).total;
    expect(total).toBeGreaterThan(500);
    for (const q of ["in:inbox", "in:archive", "in:sent", "in:trash", "in:spam", "is:unread", "is:starred", "in:drafts", "has:attachment"]) {
      expect(a.services.threads.search({ query: q }, user).total, q).toBeGreaterThan(0);
    }
    const drafts = a.services.drafts.list();
    expect(drafts.map((d) => d.createdBy.kind).sort()).toEqual(["agent", "user"]);
    const activity = a.services.activity.list({}).items;
    expect(activity.filter((x) => x.actor.kind === "agent" && x.undoable).length).toBeGreaterThanOrEqual(2);
    expect(activity.some((x) => x.undoneAt !== null)).toBe(true);
    expect(activity.map((x) => x.summary)).toContain("Archived 42 newsletters");
  });

  it("writes real attachment files (PDF, CSV, an inline image)", () => {
    const rows = a.store.db.all<{ local_path: string; mime_type: string; inline: number }>("SELECT local_path, mime_type, inline FROM attachments");
    const pdf = rows.find((r) => r.mime_type === "application/pdf")!;
    expect(fs.readFileSync(pdf.local_path).subarray(0, 5).toString()).toBe("%PDF-");
    expect(rows.some((r) => r.mime_type === "text/csv")).toBe(true);
    expect(rows.some((r) => r.inline === 1 && r.mime_type === "image/png")).toBe(true);
    expect(rows.every((r) => r.local_path.startsWith(a.dir))).toBe(true);
  });

  it("the agent's undoable activity really undoes", () => {
    const archived = a.services.activity.list({}).items.find((x) => x.summary === "Archived 42 newsletters")!;
    const before = a.services.threads.search({ query: "in:inbox" }, user).total;
    a.services.activity.undo(archived.id, user);
    expect(a.services.threads.search({ query: "in:inbox" }, user).total).toBe(before + 42);
  });

  it("can be removed (labels stay) and reset", () => {
    const labels = b.services.labels.list().length;
    b.services.demo.remove(user);
    expect(b.services.bootstrap().accounts).toHaveLength(0);
    expect(b.store.db.value("SELECT COUNT(*) FROM messages")).toBe(0);
    expect(b.store.db.value("SELECT COUNT(*) FROM message_fts")).toBe(0);
    expect(b.services.groups.list()).toHaveLength(0);
    expect(b.services.labels.list()).toHaveLength(labels);
    b.services.demo.reset(user);
    expect(b.services.bootstrap().accounts).toHaveLength(11);
  });
});
