/**
 * Address suggestions for To / Cc / Bcc, from the mail already here: everyone who wrote to you
 * and everyone you wrote to. People you wrote to come first, then the ones you hear from often
 * and lately. Your own addresses are left out.
 */
import type { Address } from "@fancy-mail/contracts";

import { parseJson } from "../db/sqlite.ts";
import { visibleAccountIds } from "./context.ts";
import type { CallContext } from "./context.ts";
import type { ServiceEnv } from "./env.ts";

/** How many of the newest matching messages are looked at. */
const SCAN = 3000;
const DAY = 24 * 60 * 60 * 1000;

interface Row {
  from_json: string | null;
  to_json: string;
  cc_json: string;
  date: number;
}

interface Seen {
  name: string | null;
  nameAt: number;
  score: number;
}

/** Case- and accent-insensitive form for matching. */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Whether every word typed starts a word of the name or appears in the address. */
export function matches(address: Address, words: string[]): boolean {
  const name = fold(address.name ?? "");
  const nameWords = name.split(/[\s.,'"()-]+/).filter(Boolean);
  const addr = fold(address.address);
  return words.every((w) => addr.includes(w) || nameWords.some((n) => n.startsWith(w)) || name.includes(w));
}

export function createContactsService(env: ServiceEnv) {
  const { store, db } = env;

  return {
    suggest(input: { query: string; limit?: number }, ctx: CallContext): Address[] {
      const query = input.query.trim();
      if (!query) return [];
      const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
      const accounts = store.accounts.list();
      const own = new Set(accounts.map((a) => a.email.toLowerCase()));
      const visible = visibleAccountIds(ctx, accounts) ?? accounts.map((a) => a.id);
      if (visible.length === 0) return [];

      // Narrow in SQL by the longest word typed, then match properly here.
      const words = fold(query).split(/\s+/).filter(Boolean);
      const longest = [...query.split(/\s+/)].sort((a, b) => b.length - a.length)[0]!;
      const like = `%${longest.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const rows = db.all<Row>(
        `SELECT from_json, to_json, cc_json, date FROM messages
          WHERE account_id IN (${visible.map(() => "?").join(", ")}) AND is_draft = 0
            AND (from_json LIKE ? ESCAPE '\\' OR to_json LIKE ? ESCAPE '\\' OR cc_json LIKE ? ESCAPE '\\')
          ORDER BY date DESC LIMIT ${SCAN}`,
        ...visible,
        like,
        like,
        like,
      );

      const now = env.now();
      const seen = new Map<string, Seen>();
      const note = (a: Address | null | undefined, weight: number, date: number) => {
        if (!a?.address) return;
        const key = a.address.trim().toLowerCase();
        if (!key || own.has(key) || /^(no-?reply|do-?not-?reply|mailer-daemon)@/.test(key)) return;
        if (!matches(a, words)) return;
        // Newer counts more: a message today counts fully, a year-old one about a fifth.
        const fresh = 1 / (1 + Math.max(0, now - date) / (90 * DAY));
        const entry = seen.get(key) ?? { name: null, nameAt: 0, score: 0 };
        entry.score += weight * (0.25 + fresh);
        const name = a.name?.trim();
        if (name && name.toLowerCase() !== key && date >= entry.nameAt) {
          entry.name = name;
          entry.nameAt = date;
        }
        seen.set(key, entry);
      };

      for (const row of rows) {
        const from = parseJson<Address | null>(row.from_json, null);
        const fromMe = !!from && own.has(from.address.toLowerCase());
        const to = parseJson<Address[]>(row.to_json, []);
        const cc = parseJson<Address[]>(row.cc_json, []);
        if (fromMe) {
          // Someone you wrote to.
          for (const a of to) note(a, 4, row.date);
          for (const a of cc) note(a, 2, row.date);
        } else {
          note(from, 1, row.date);
          for (const a of cc) note(a, 0.3, row.date);
        }
      }

      const typedAddress = fold(query);
      return [...seen.entries()]
        .map(([address, s]) => ({
          address,
          name: s.name,
          // An address that starts with what was typed counts double.
          rank: s.score * (address.startsWith(typedAddress) ? 2 : 1),
        }))
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit)
        .map(({ address, name }) => ({ name, address }));
    },
  };
}

export type ContactsService = ReturnType<typeof createContactsService>;
