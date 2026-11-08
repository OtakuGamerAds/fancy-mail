import { describe, expect, it } from "vitest";

import { parseQuery } from "./query.ts";

describe("parseQuery", () => {
  const now = new Date(2026, 10, 7).getTime();

  it("splits keys, phrases and negation", () => {
    expect(parseQuery('from:ads@google.com "monthly invoice" -label:Newsletters is:unread', now).terms).toEqual([
      { kind: "field", field: "from", value: "ads@google.com", negated: false },
      { kind: "text", value: "monthly invoice", negated: false },
      { kind: "label", value: "Newsletters", negated: true },
      { kind: "is", value: "unread", negated: false },
    ]);
  });

  it("reads quoted values after a key and keeps unknown keys as text", () => {
    expect(parseQuery('label:"Tax 2026" re:hello', now).terms).toEqual([
      { kind: "label", value: "Tax 2026", negated: false },
      { kind: "text", value: "re:hello", negated: false },
    ]);
  });

  it("turns dates, ages and sizes into numbers", () => {
    const { terms, errors } = parseQuery("after:2026-07-01 newer_than:7d larger:5M", now);
    expect(errors).toEqual([]);
    expect(terms).toEqual([
      { kind: "date", op: "after", at: new Date(2026, 6, 1).getTime() },
      { kind: "date", op: "after", at: now - 7 * 86_400_000 },
      { kind: "size", op: "larger", bytes: 5 * 1024 * 1024 },
    ]);
  });

  it("refuses OR and parentheses instead of searching for the word", () => {
    const { terms, errors } = parseQuery("(from:a.example OR from:b.example)", now);
    expect(terms.map((t) => t.kind)).toEqual(["field", "field"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe("Parentheses are not supported: all terms must match.");
    expect(errors[1]).toContain("Run one search per alternative");
  });

  it("leaves out what it cannot read and says how to write it", () => {
    const { terms, errors } = parseQuery("in:nowhere before:yesterday invoice", now);
    expect(terms).toEqual([{ kind: "text", value: "invoice", negated: false }]);
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain("before:2026-07-31");
  });
});
