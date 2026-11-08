/**
 * Labels on plain IMAP servers are mirrored as keywords: "$FM_" plus the label name, encoded so
 * that any name (spaces, umlauts, Arabic, emoji) becomes a valid IMAP atom and decodes back to
 * exactly the same name. ASCII letters, digits, "-" and "." stay as they are, so the keyword is
 * readable in other clients ("Invoices" → "$FM_Invoices"); every other byte of the UTF-8 name
 * becomes "_" plus two hex digits ("Work Stuff" → "$FM_Work_20Stuff").
 *
 * Gmail labels are not keywords: they go through X-GM-LABELS by name (see mailboxes.ts).
 */
export const KEYWORD_PREFIX = "$FM_";

const PLAIN = /^[A-Za-z0-9.-]$/;

export function labelToKeyword(name: string): string {
  let out = KEYWORD_PREFIX;
  for (const byte of Buffer.from(name.normalize("NFC"), "utf8")) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && PLAIN.test(ch) ? ch : `_${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The label name of one of our keywords, or null for any other keyword or a damaged one. */
export function keywordToLabel(keyword: string): string | null {
  if (keyword.length <= KEYWORD_PREFIX.length || keyword.slice(0, KEYWORD_PREFIX.length).toUpperCase() !== KEYWORD_PREFIX) return null;
  const body = keyword.slice(KEYWORD_PREFIX.length);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "_") {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (PLAIN.test(ch)) {
      bytes.push(ch.charCodeAt(0));
    } else {
      return null;
    }
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  // Invalid UTF-8 decodes to U+FFFD: not one of ours.
  if (decoded.includes("�") || !decoded.trim()) return null;
  return decoded;
}

/** Whether a mailbox lets us set our own keywords (PERMANENTFLAGS has \*). Unknown: assume yes. */
export function keywordsAllowed(permanentFlags: Set<string> | undefined): boolean {
  if (!permanentFlags || permanentFlags.size === 0) return true;
  return permanentFlags.has("\\*");
}

/** Our label names among a message's flags. */
export function labelsFromFlags(flags: Iterable<string>): string[] {
  const out: string[] = [];
  for (const flag of flags) {
    const name = keywordToLabel(flag);
    if (name) out.push(name);
  }
  return out;
}
