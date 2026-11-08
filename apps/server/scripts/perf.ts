/**
 * Timing check on a big mailbox: N synthetic messages (default 100,000) in 20 accounts, then the
 * list and search queries the app runs. Uses a temp dir.
 *
 *   node scripts/electron-node.mjs apps/server/scripts/perf.ts [messages]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { newId } from "../src/db/ids.ts";
import { addAccount, addLabel, createTestStack, user } from "../src/testing.ts";

const total = Number(process.argv[2] ?? 100_000);
const stack = createTestStack();
const { store, services } = stack;
const words = "rechnung invoice payment meeting sponsorship video channel steuer bank statement report draft release update offer contract shipping travel family photo review".split(" ");
const rnd = (n: number) => Math.floor(Math.random() * n);

const labels = ["Invoices", "Receipts", "Taxes", "Sponsorships", "Newsletters"].map((n) => addLabel(store, n));
const accounts = Array.from({ length: 20 }, (_, i) => addAccount(store, { email: `acc${i}@perf.test`, style: i % 2 ? "gmail" : "imap" }));

let t = performance.now();
const threadIds: string[] = [];
store.db.tx(() => {
  let made = 0;
  while (made < total) {
    const built = accounts[rnd(accounts.length)]!;
    const threadId = newId("thr");
    threadIds.push(threadId);
    const size = 1 + rnd(4);
    const start = Date.now() - rnd(365 * 86_400_000);
    for (let i = 0; i < size && made < total; i++, made++) {
      const id = newId("msg");
      const subject = `${words[rnd(words.length)]} ${words[rnd(words.length)]} ${rnd(10000)}`;
      store.messages.insert({
        id,
        accountId: built.accountId,
        threadId,
        remoteId: id,
        gmThreadId: null,
        messageIdHeader: `<${id}@perf>`,
        inReplyTo: null,
        references: [],
        subject,
        from: { name: `Sender ${rnd(500)}`, address: `s${rnd(500)}@example.test` },
        to: [{ name: null, address: "me@perf.test" }],
        cc: [],
        bcc: [],
        replyTo: [],
        date: start + i * 3_600_000,
        snippet: subject,
        size: 2000 + rnd(200_000),
        unread: Math.random() < 0.1,
        starred: Math.random() < 0.02,
        isDraft: false,
        hasAttachments: Math.random() < 0.15,
        bodyState: "none",
      });
      const roll = Math.random();
      const role = roll < 0.3 ? "inbox" : roll < 0.9 ? (built.boxes.has("all") ? "all" : "sent") : "trash";
      store.messages.addLocation(id, built.boxes.get(role)!.id, made);
      if (built.boxes.has("all") && role === "inbox") store.messages.addLocation(id, built.boxes.get("all")!.id, null);
      if (Math.random() < 0.2) store.messages.addLabel(id, labels[rnd(labels.length)]!);
    }
  }
});
console.log(`inserted ${total} messages in ${threadIds.length} threads: ${Math.round(performance.now() - t)} ms`);
t = performance.now();
store.refreshThreads(threadIds);
console.log(`refreshThreads: ${Math.round(performance.now() - t)} ms`);
store.db.exec("ANALYZE");

const queries = [
  "in:inbox",
  "is:unread in:inbox",
  `account:acc3@perf.test in:inbox`,
  "label:Invoices",
  "has:attachment",
  "in:archive",
  "in:trash",
  "",
  "rechnung",
  "invoi",
  "rechnung has:attachment",
  "from:s12@example.test",
  "sponsorship video -label:Newsletters",
  "larger:150K",
];
for (const q of queries) {
  services.threads.search({ query: q, limit: 50 }, user); // warm
  const runs: number[] = [];
  let result = services.threads.search({ query: q, limit: 50 }, user);
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    result = services.threads.search({ query: q, limit: 50 }, user);
    runs.push(performance.now() - s);
  }
  runs.sort((x, y) => x - y);
  console.log(`${JSON.stringify(q).padEnd(42)} median ${runs[2]!.toFixed(1).padStart(6)} ms   total ${result.total}`);
}
t = performance.now();
services.bootstrap();
console.log(`bootstrap: ${Math.round(performance.now() - t)} ms`);
const size = fs.statSync(path.join(stack.dir, "mail.db")).size;
console.log(`database: ${(size / 1024 / 1024).toFixed(1)} MB in ${os.tmpdir()}`);
stack.cleanup();
