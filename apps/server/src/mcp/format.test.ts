import { describe, expect, it } from "vitest";

import { parseAddress, stripQuoted, truncateBody } from "./format.ts";

describe("stripQuoted", () => {
  it("drops > lines and everything after an attribution line", () => {
    const text = [
      "Danke, passt so.",
      "",
      "Am 03.11.2026 um 14:05 schrieb Anna Weber <anna@kanzlei.example>:",
      "> Können Sie die Belege bis Freitag schicken?",
      "> Viele Grüße",
    ].join("\n");
    expect(stripQuoted(text)).toEqual({ text: "Danke, passt so.", stripped: true });
  });

  it("leaves a message without quotes as it is", () => {
    expect(stripQuoted("Hi,\n\nsee attached.")).toEqual({ text: "Hi,\n\nsee attached.", stripped: false });
  });
});

describe("truncateBody", () => {
  it("says how many characters are left and what to ask for", () => {
    const { text, note } = truncateBody("x".repeat(5000), 4000);
    expect(text).toHaveLength(4000);
    expect(note).toBe("[… 1,000 more characters — call again with max_chars_per_message: 8000]");
  });
});

describe("parseAddress", () => {
  it("reads the common ways people write an address", () => {
    expect(parseAddress("Anna Weber <anna@kanzlei.example>")).toEqual({ name: "Anna Weber", address: "anna@kanzlei.example" });
    expect(parseAddress('"Weber, Anna" <anna@kanzlei.example>')).toEqual({ name: "Weber, Anna", address: "anna@kanzlei.example" });
    expect(parseAddress("anna@kanzlei.example")).toEqual({ name: null, address: "anna@kanzlei.example" });
    expect(parseAddress("Anna")).toBeNull();
  });
});
