/**
 * Plain-text bodies: where the quoted tail starts (lines starting with ">", "On … wrote:",
 * Outlook's "-----Original Message-----" / "Von: … Gesendet: …" headers), paragraphs for
 * per-paragraph text direction, and the links inside a line.
 */

const ATTRIBUTION =
  /^\s*(?:On|Am|Le|El|Il|Op|Em|Den|W dniu|在)\b.{3,300}(?:wrote|schrieb|a écrit|escribió|ha scritto|schreef|escreveu|skrev|napisał|写道)\s*:?\s*$/i;
const ARABIC_ATTRIBUTION = /كتب.{0,80}:\s*$/;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Message d'origine|Forwarded message|Weitergeleitete Nachricht)\s*-{2,}\s*$/i;
const OUTLOOK_HEADER = /^\s*(?:From|Von|De|Da|Van):\s+.+$/i;
const OUTLOOK_NEXT = /^\s*(?:Sent|Gesendet|Envoyé|Inviato|Verzonden|Date|Datum):\s+.+$/i;

export interface PlainTextParts {
  /** The new text of the message. */
  body: string;
  /** The quoted history after it, folded under "···". */
  quote: string | null;
}

function isQuoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

/** Splits off the quoted tail, when everything after some point is history. */
export function splitQuotedTail(text: string): PlainTextParts {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let candidate = -1;
    if (ORIGINAL_MESSAGE.test(line)) candidate = i;
    else if (OUTLOOK_HEADER.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_NEXT.test(l))) candidate = i;
    else if (ATTRIBUTION.test(line) || ARABIC_ATTRIBUTION.test(line)) candidate = i;
    else if (
      // Gmail wraps long attributions onto two lines: "On Tue, Nov 3, 2026 at 9:10 AM Anna" / "<anna@x> wrote:"
      i + 1 < lines.length &&
      /^\s*(?:On|Am|Le)\b/i.test(line) &&
      /(?:wrote|schrieb|a écrit)\s*:\s*$/i.test(lines[i + 1]!)
    )
      candidate = i;
    else if (isQuoteLine(line)) candidate = i;

    if (candidate === -1) continue;
    // Everything after it must be quoted lines, blank lines, or more headers/attributions.
    const rest = lines.slice(candidate + 1);
    const restIsHistory =
      ORIGINAL_MESSAGE.test(line) || OUTLOOK_HEADER.test(line)
        ? true
        : rest.every((l) => l.trim() === "" || isQuoteLine(l));
    if (restIsHistory) {
      start = candidate;
      break;
    }
  }

  if (start <= 0) {
    // A message that is only a quote stays as it is (there is nothing else to show).
    return { body: text, quote: null };
  }
  const body = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  const quote = lines.slice(start).join("\n").replace(/\s+$/, "");
  if (!body.trim()) return { body: text, quote: null };
  return { body, quote: quote.trim() ? quote : null };
}

/** Paragraphs separated by blank lines, so each one can take its own direction. */
export function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim().length > 0);
}

export type TextToken = { kind: "text"; value: string } | { kind: "link"; value: string; href: string };

const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+[^\s<>"')\].,;:!?]|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;

/** Splits text into plain runs and links (web addresses and email addresses). */
export function linkify(text: string): TextToken[] {
  const out: TextToken[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "text", value: text.slice(last, index) });
    const href = value.includes("@") && !/^https?:|^www\./i.test(value)
      ? `mailto:${value}`
      : /^www\./i.test(value)
        ? `https://${value}`
        : value;
    out.push({ kind: "link", value, href });
    last = index + value.length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

/** "Re: Rechnung" for a reply, without stacking prefixes ("Re: Re: AW: …"). */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^(re|aw|sv|antw|r)\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed || "(no subject)"}`;
}

export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^(fwd?|wg|tr|rv)\s*:/i.test(trimmed)) return trimmed;
  return `Fwd: ${trimmed || "(no subject)"}`;
}

/** The marker the composer writes before a quoted original; also used to split it back off. */
export const QUOTE_SEPARATOR = /\n\n(On .{1,300} wrote:\n(?:>.*(?:\n|$))*\s*)$/;
export const FORWARD_SEPARATOR = /\n\n(-{10} Forwarded message -{9}\n[\s\S]*)$/;

/** Separates what the person wrote from the quoted/forwarded original in a saved draft. */
export function splitDraftBody(bodyText: string): { text: string; quote: string | null } {
  const forward = FORWARD_SEPARATOR.exec(bodyText);
  if (forward) return { text: bodyText.slice(0, forward.index), quote: forward[1]! };
  const quote = QUOTE_SEPARATOR.exec(bodyText);
  if (quote) return { text: bodyText.slice(0, quote.index), quote: quote[1]! };
  return { text: bodyText, quote: null };
}

export function quoteText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
}
