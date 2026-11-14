/**
 * The little formatting a summary has: blank lines separate paragraphs, lines starting with
 * "- ", "* " or "• " are a list, "1. " a numbered one, and **text** is bold. Everything else is
 * plain text (never HTML: agents write it, often from what strangers wrote).
 */

export type SummaryInline = { text: string; bold: boolean };
export type SummaryBlock =
  | { kind: "paragraph"; lines: SummaryInline[][] }
  | { kind: "list"; ordered: boolean; items: SummaryInline[][] };

const BULLET = /^\s*(?:[-*•])\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

export function parseInline(text: string): SummaryInline[] {
  const out: SummaryInline[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), bold: false });
    out.push({ text: match[1]!, bold: true });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

export function parseSummary(text: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  let current: SummaryBlock | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      current = null;
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = Boolean(numbered);
      if (!current || current.kind !== "list" || current.ordered !== ordered) {
        current = { kind: "list", ordered, items: [] };
        blocks.push(current);
      }
      current.items.push(parseInline(item[1]!.trim()));
    } else if (current?.kind === "list" && /^\s{2,}\S/.test(raw)) {
      // An indented line continues the item above it.
      const items = current.items;
      items[items.length - 1] = [...items[items.length - 1]!, { text: ` ${line.trim()}`, bold: false }];
    } else {
      if (!current || current.kind !== "paragraph") {
        current = { kind: "paragraph", lines: [] };
        blocks.push(current);
      }
      current.lines.push(parseInline(line.trim()));
    }
  }
  return blocks;
}
