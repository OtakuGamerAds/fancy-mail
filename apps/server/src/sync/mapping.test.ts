import { describe, expect, it } from "vitest";

import { matchAttachments } from "./bodies.ts";
import { attachmentParts, messageDate, referencesFromHeaders } from "./headers.ts";
import { KEYWORD_PREFIX, keywordToLabel, keywordsAllowed, labelToKeyword, labelsFromFlags } from "./keywords.ts";
import { gmailLabelForRole, planMailboxes, specialUseRole, splitGmailLabels } from "./mailboxes.ts";
import type { ServerMailbox } from "./mailboxes.ts";
import { replyHeaders, withSignature } from "./smtp.ts";

describe("keywords", () => {
  it("round-trips any label name through a valid IMAP atom", () => {
    for (const name of ["Invoices", "Work Stuff", "Rechnungen Ü", "فواتير", "Steuern 2026/Q1", "a_b", "emoji 📎", "(x)%*\"\\]{"]) {
      const keyword = labelToKeyword(name);
      expect(keyword.startsWith(KEYWORD_PREFIX)).toBe(true);
      expect(keyword).toMatch(/^\$FM_[A-Za-z0-9._-]+$/);
      expect(keywordToLabel(keyword)).toBe(name);
    }
  });

  it("keeps plain names readable", () => {
    expect(labelToKeyword("Invoices")).toBe("$FM_Invoices");
    expect(labelToKeyword("Work Stuff")).toBe("$FM_Work_20Stuff");
  });

  it("ignores other keywords and damaged ones", () => {
    expect(keywordToLabel("$Forwarded")).toBeNull();
    expect(keywordToLabel("\\Seen")).toBeNull();
    expect(keywordToLabel("$FM_")).toBeNull();
    expect(keywordToLabel("$FM_bad_Z1")).toBeNull();
    expect(keywordToLabel("$FM__FF")).toBeNull(); // not UTF-8
    expect(labelsFromFlags(new Set(["\\Seen", "$FM_Invoices", "$Junk", "$fm_Travel"]))).toEqual(["Invoices", "Travel"]);
  });

  it("knows when a mailbox takes keywords", () => {
    expect(keywordsAllowed(new Set(["\\Seen", "\\*"]))).toBe(true);
    expect(keywordsAllowed(new Set(["\\Seen", "\\Flagged"]))).toBe(false);
    expect(keywordsAllowed(undefined)).toBe(true);
  });
});

describe("Gmail labels and roles", () => {
  it("splits X-GM-LABELS into system roles and user labels", () => {
    const { roles, names } = splitGmailLabels(["\\Inbox", "\\Important", "\\Starred", "Invoices", "Work/Clients", "\\Muted", "\\Sent"]);
    expect([...roles].sort()).toEqual(["important", "inbox", "sent", "starred"]);
    expect(names).toEqual(["Invoices", "Work/Clients"]);
  });

  it("maps roles back to the labels archive and move-to-inbox change", () => {
    expect(gmailLabelForRole("inbox")).toBe("\\Inbox");
    expect(gmailLabelForRole("trash")).toBeNull(); // trash is a MOVE, not a label
  });

  it("maps special-use flags; off Gmail, virtual folders get no role", () => {
    expect(specialUseRole("\\Junk", false)).toBe("spam");
    expect(specialUseRole("\\All", true)).toBe("all");
    expect(specialUseRole("\\All", false)).toBeNull();
    expect(specialUseRole("\\Flagged", true)).toBe("starred");
    expect(specialUseRole("\\Flagged", false)).toBeNull();
  });
});

function box(path: string, specialUse: string | null, flags: string[] = [], source: string | null = "extension"): ServerMailbox {
  return { path, name: path.split("/").at(-1)!, delimiter: "/", specialUse, specialUseSource: specialUse ? source : null, flags };
}

describe("planMailboxes", () => {
  it("Gmail: system folders only, All Mail/Trash/Spam synced, user labels left to labels", () => {
    const plan = planMailboxes(
      [
        box("INBOX", "\\Inbox"),
        box("[Gmail]", null, ["\\Noselect"]),
        box("[Gmail]/All Mail", "\\All"),
        box("[Gmail]/Sent Mail", "\\Sent"),
        box("[Gmail]/Trash", "\\Trash"),
        box("[Gmail]/Spam", "\\Junk"),
        box("[Gmail]/Starred", "\\Flagged"),
        box("[Gmail]/Important", "\\Important"),
        box("Invoices", null),
      ],
      true,
    );
    expect(plan.map((p) => p.path)).not.toContain("Invoices");
    expect(plan.filter((p) => p.synced).map((p) => p.role).sort()).toEqual(["all", "spam", "trash"]);
    expect(plan.find((p) => p.path === "INBOX")).toMatchObject({ role: "inbox", name: "Inbox", synced: false });
  });

  it("IMAP: every selectable folder, virtual ones skipped, one folder per role", () => {
    const plan = planMailboxes(
      [
        box("INBOX", null),
        box("Sent", "\\Sent", [], "name"),
        box("Sent Messages", "\\Sent", [], "extension"),
        box("Virtual/All", "\\All"),
        box("Projects", null),
        box("Shared", null, ["\\Noselect"]),
      ],
      false,
    );
    expect(plan.map((p) => p.path).sort()).toEqual(["INBOX", "Projects", "Sent", "Sent Messages"]);
    expect(plan.find((p) => p.path === "Sent Messages")!.role).toBe("sent");
    expect(plan.find((p) => p.path === "Sent")!.role).toBeNull();
    expect(plan[0]!.path).toBe("INBOX");
    expect(plan.every((p) => p.synced)).toBe(true);
  });
});

describe("headers", () => {
  it("finds files in a BODYSTRUCTURE, with part ids, skipping the text bodies", () => {
    const parts = attachmentParts({
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "multipart/alternative", childNodes: [{ part: "1.1", type: "text/plain" }, { part: "1.2", type: "text/html" }] },
        { part: "2", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "report.pdf" }, encoding: "base64", size: 1336 },
        { part: "3", type: "image/png", id: "<logo@x>", disposition: "inline", parameters: { name: "logo.png" }, size: 100 },
        { part: "4", type: "message/rfc822", childNodes: [{ part: "4.1", type: "text/plain" }], size: 900 },
      ],
    });
    expect(parts).toEqual([
      { part: "2", filename: "report.pdf", mimeType: "application/pdf", size: 1002, contentId: null, inline: false },
      { part: "3", filename: "logo.png", mimeType: "image/png", size: 100, contentId: "logo@x", inline: true },
      { part: "4", filename: "message.eml", mimeType: "message/rfc822", size: 900, contentId: null, inline: false },
    ]);
    expect(attachmentParts({ type: "text/plain" })).toEqual([]);
  });

  it("reads References from a folded header block", () => {
    expect(referencesFromHeaders(Buffer.from("References: <a@x>\r\n <b@y>\r\n\r\n"))).toEqual(["<a@x>", "<b@y>"]);
    expect(referencesFromHeaders(undefined)).toEqual([]);
  });

  it("uses the Date header unless it is absurd", () => {
    const now = Date.UTC(2026, 10, 8);
    expect(messageDate(new Date(Date.UTC(2026, 10, 1)), new Date(now), now)).toBe(Date.UTC(2026, 10, 1));
    expect(messageDate(new Date(Date.UTC(2031, 0, 1)), new Date(now - 1000), now)).toBe(now - 1000);
    expect(messageDate(undefined, undefined, now)).toBe(now);
  });
});

describe("attachments after the body download", () => {
  it("pairs parsed files with the BODYSTRUCTURE rows by Content-ID, name, then type", () => {
    const rows = [
      { filename: "a.pdf", mimeType: "application/pdf", contentId: null },
      { filename: "logo.png", mimeType: "image/png", contentId: "logo@x" },
      { filename: "attachment", mimeType: "text/csv", contentId: null },
    ];
    const parsed = [
      { filename: "image.png", mimeType: "image/png", contentId: "logo@x" },
      { filename: "data.csv", mimeType: "text/csv", contentId: null },
      { filename: "a.pdf", mimeType: "application/pdf", contentId: null },
      { filename: "extra.txt", mimeType: "text/plain", contentId: null },
    ];
    expect(matchAttachments(rows, parsed)).toEqual([1, 2, 0, -1]);
  });
});

describe("sending", () => {
  it("appends the signature after '-- ' once", () => {
    expect(withSignature("Hi", "Ada\nCEO")).toBe("Hi\n\n-- \nAda\nCEO");
    expect(withSignature("Hi\n\n-- \nAda\nCEO", "Ada\nCEO")).toBe("Hi\n\n-- \nAda\nCEO");
    expect(withSignature("Hi", "  ")).toBe("Hi");
  });

  it("answers with In-Reply-To and References; forwards keep only References", () => {
    const source = { messageIdHeader: "<2@x>", references: ["<1@x>"] };
    expect(replyHeaders({ mode: "reply" }, source)).toEqual({ inReplyTo: "<2@x>", references: ["<1@x>", "<2@x>"] });
    expect(replyHeaders({ mode: "forward" }, source)).toEqual({ inReplyTo: null, references: ["<1@x>", "<2@x>"] });
    expect(replyHeaders({ mode: "new" }, source)).toEqual({ inReplyTo: null, references: [] });
  });
});
