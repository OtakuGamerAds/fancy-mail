import { randomBytes } from "node:crypto";

export const ID_PREFIXES = ["acc", "grp", "lbl", "mbx", "msg", "thr", "att", "drf", "act", "upl", "op"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** `${prefix}_${base32 of 12 random bytes}`, e.g. `thr_k5x2...`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${base32(randomBytes(12))}`;
}

/** The same shape from bytes you provide (the demo seed uses a seeded generator). */
export function idFromBytes(prefix: IdPrefix, bytes: Uint8Array): string {
  return `${prefix}_${base32(bytes)}`;
}

export function hasPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`);
}
