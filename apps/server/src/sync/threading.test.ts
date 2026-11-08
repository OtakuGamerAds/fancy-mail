import { describe, expect, it } from "vitest";

import { ThreadIndex, normalizeSubject, parseMessageIds } from "./threading.ts";
import type { ThreadCandidate } from "./threading.ts";

const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 10, 1);

function msg(over: Partial<ThreadCandidate>): ThreadCandidate {
  return {
    messageIdHeader: null,
    inReplyTo: null,
    references: [],
    subject: "Project kickoff",
    date: T0,
    from: { name: "Ada", address: "ada@example.test" },
    to: [{ name: null, address: "me@example.test" }],
    cc: [],
    ...over,
  };
}

describe("normalizeSubject", () => {
  it("strips reply and forward prefixes in many languages, repeatedly", () => {
    expect(normalizeSubject("Re: AW: Fwd: Invoice #12")).toBe("invoice #12");
    expect(normalizeSubject("WG: Antw: Termin")).toBe("termin");
    expect(normalizeSubject("RE[2]: re(3): Budget")).toBe("budget");
    expect(normalizeSubject("Fw: SV: VS: Planning")).toBe("planning");
    expect(normalizeSubject("Re：Hello there")).toBe("hello there");
    expect(normalizeSubject("  Re:   Spaced    out  ")).toBe("spaced out");
  });

  it("leaves words that only start like a prefix", () => {
    expect(normalizeSubject("Report: Q3")).toBe("report: q3");
    expect(normalizeSubject("Fwdr meeting")).toBe("fwdr meeting");
    expect(normalizeSubject("Rechnung März")).toBe("rechnung märz");
  });
});

describe("parseMessageIds", () => {
  it("reads References and bare ids", () => {
    expect(parseMessageIds("<a@x> <b@y>\r\n <c@z>")).toEqual(["<a@x>", "<b@y>", "<c@z>"]);
    expect(parseMessageIds("lonely@host")).toEqual(["<lonely@host>"]);
    expect(parseMessageIds("")).toEqual([]);
    expect(parseMessageIds(null)).toEqual([]);
  });
});

describe("ThreadIndex", () => {
  let n = 0;
  const makeId = () => `thr_${++n}`;

  it("joins a reply to the message it answers", () => {
    const index = new ThreadIndex(["me@example.test"]);
    const first = msg({ messageIdHeader: "<1@x>" });
    index.add(first, "thr_a");
    const reply = msg({ messageIdHeader: "<2@x>", inReplyTo: "<1@x>", references: ["<1@x>"], subject: "Re: Project kickoff" });
    expect(index.resolve(reply, makeId)).toMatchObject({ threadId: "thr_a", isNew: false });
  });

  it("joins the original to a reply that arrived first (newest-first sync)", () => {
    const index = new ThreadIndex(["me@example.test"]);
    index.add(msg({ messageIdHeader: "<2@x>", inReplyTo: "<1@x>", references: ["<1@x>"], subject: "Re: Totally different" }), "thr_r");
    const original = msg({ messageIdHeader: "<1@x>", subject: "Totally different" });
    expect(index.resolve(original, makeId).threadId).toBe("thr_r");
  });

  it("joins two replies that answer the same missing message", () => {
    const index = new ThreadIndex(["me@example.test"]);
    index.add(msg({ messageIdHeader: "<3@x>", references: ["<1@x>", "<2@x>"], subject: "Re: x" }), "thr_one");
    const sibling = msg({ messageIdHeader: "<4@x>", references: ["<1@x>"], subject: "Re: something else" });
    expect(index.resolve(sibling, makeId).threadId).toBe("thr_one");
  });

  it("reports threads a message bridges, to merge them", () => {
    const index = new ThreadIndex(["me@example.test"]);
    index.add(msg({ messageIdHeader: "<a@x>", subject: "Alpha" }), "thr_alpha");
    index.add(msg({ messageIdHeader: "<b@x>", subject: "Beta" }), "thr_beta");
    const bridge = msg({ messageIdHeader: "<c@x>", inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] });
    const resolved = index.resolve(bridge, makeId);
    expect(resolved.threadId).toBe("thr_beta");
    expect(resolved.merge).toEqual(["thr_alpha"]);
    index.rename("thr_alpha", "thr_beta");
    expect(index.resolve(msg({ inReplyTo: "<a@x>" }), makeId).threadId).toBe("thr_beta");
  });

  it("groups by subject only with a shared participant within 30 days", () => {
    const index = new ThreadIndex(["me@example.test"]);
    index.add(msg({ subject: "Offsite planning", date: T0 }), "thr_s");
    expect(index.resolve(msg({ subject: "Re: Offsite planning", date: T0 + 2 * DAY }), makeId).threadId).toBe("thr_s");
    // Somebody else, same subject: a different conversation.
    const stranger = msg({ subject: "Re: Offsite planning", from: { name: "Zed", address: "zed@other.test" }, date: T0 + DAY });
    expect(index.resolve(stranger, makeId).isNew).toBe(true);
    // Too late.
    expect(index.resolve(msg({ subject: "Offsite planning", date: T0 + 45 * DAY }), makeId).isNew).toBe(true);
  });

  it("never groups generic subjects by subject alone", () => {
    const index = new ThreadIndex(["me@example.test"]);
    index.add(msg({ subject: "Invoice" }), "thr_inv");
    expect(index.resolve(msg({ subject: "Invoice", date: T0 + DAY }), makeId).isNew).toBe(true);
    index.add(msg({ subject: "" }), "thr_empty");
    expect(index.resolve(msg({ subject: "" }), makeId).isNew).toBe(true);
  });

  it("does not count the account's own address as a shared participant", () => {
    const index = new ThreadIndex(["me@example.test"]);
    index.add(msg({ subject: "Weekly sync", from: { name: "A", address: "a@x.test" } }), "thr_w");
    const other = msg({ subject: "Weekly sync", from: { name: "B", address: "b@y.test" }, date: T0 + DAY });
    expect(index.resolve(other, makeId).isNew).toBe(true);
  });
});
