import type { Address } from "@fancy-mail/contracts";

const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]{2,}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** "Anna Weber", or the part before the @ when there is no name. */
export function displayName(address: Address | null | undefined): string {
  if (!address) return "Unknown sender";
  const name = address.name?.trim().replace(/^["']|["']$/g, "");
  if (name) return name;
  return address.address.split("@")[0] || address.address;
}

/** "Anna Weber <anna@weber.example>", or the bare address. */
export function formatAddress(address: Address): string {
  const name = address.name?.trim();
  if (!name || name === address.address) return address.address;
  const quoted = /[",;<>@()]/.test(name) ? `"${name.replace(/"/g, "")}"` : name;
  return `${quoted} <${address.address}>`;
}

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Reads what was typed or pasted into a recipient field: a single address or a list separated
 * by commas, semicolons or new lines. "Anna Weber <anna@x.example>", "<anna@x.example>" and
 * "anna@x.example" all work; quoted names may contain commas.
 */
export function parseAddressList(input: string): { address: Address; valid: boolean; raw: string }[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "<") angle = true;
    if (!quoted && ch === ">") angle = false;
    if (!quoted && !angle && (ch === "," || ch === ";" || ch === "\n" || ch === "\r")) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  const out: { address: Address; valid: boolean; raw: string }[] = [];
  for (const raw of parts) {
    const angleMatch = /^(.*?)<([^>]+)>\s*$/.exec(raw);
    let name: string | null = null;
    let email: string;
    if (angleMatch) {
      name = angleMatch[1]!.trim().replace(/^["']|["']$/g, "").trim() || null;
      email = angleMatch[2]!.trim();
    } else {
      // "mailto:anna@x.example" pasted from a link.
      email = raw.replace(/^mailto:/i, "").trim();
      // A space-separated paste of several bare addresses.
      const pieces = email.split(/\s+/).filter(Boolean);
      if (pieces.length > 1 && pieces.every((p) => isValidEmail(p))) {
        for (const piece of pieces) out.push({ address: { name: null, address: piece }, valid: true, raw: piece });
        continue;
      }
    }
    out.push({ address: { name, address: email }, valid: isValidEmail(email), raw });
  }
  return out;
}

/** Removes repeats (same address, any case), keeping the first. */
export function uniqueAddresses(list: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const a of list) {
    const key = a.address.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** A stable hue for someone without an account color (avatars in the reader). */
export function colorForAddress(value: string): string {
  let hash = 0;
  for (const ch of value.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hues = [217, 262, 292, 330, 0, 24, 38, 84, 152, 172, 190, 215];
  const hue = hues[Math.abs(hash) % hues.length]!;
  return `oklch(0.68 0.14 ${hue})`;
}

export function initialOf(text: string): string {
  const match = /\p{L}|\p{N}/u.exec(text);
  return (match?.[0] ?? "?").toUpperCase();
}
