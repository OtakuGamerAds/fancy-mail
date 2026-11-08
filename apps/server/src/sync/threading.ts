/**
 * Which conversation a downloaded message belongs to.
 *
 *   Gmail: X-GM-THRID, Google's own threads.
 *   Others: In-Reply-To / References pointing at a message we have (or at a message another one
 *   of ours also points at: replies often arrive before the message they answer, because the
 *   first sync goes newest first); else the same normalized subject with a shared participant
 *   within 30 days; else a new conversation.
 *
 * The index is kept in memory per account and built from the database on first use.
 */
import type { Address } from "@fancy-mail/contracts";

const PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|antw(?:ort)?|sv|vs|tr|rif|r|ref|odp|enc|res|doorst|vl|ynt|atb|réf|πλ|הועבר|回复|转发|回覆|答复)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]|\[(?:fwd?|re)\s*:[^\]]*\])\s*/iu;

/** "Re: AW: Fwd: Invoice  #12" → "invoice #12". */
export function normalizeSubject(subject: string): string {
  let s = subject.normalize("NFC").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 20; i++) {
    const next = s.replace(PREFIX, "").trim();
    if (next === s) break;
    s = next;
  }
  // "Invoice (fwd)" style suffixes.
  s = s.replace(/\s*\((?:fwd?|forwarded)\)\s*$/i, "").trim();
  return s.toLocaleLowerCase();
}

/** Message-IDs from a References/In-Reply-To header ("<a@b> <c@d>"). */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const found = value.match(/<[^<>\s]+>/g);
  if (found && found.length > 0) return [...new Set(found)];
  const bare = value.trim();
  return bare && !/\s/.test(bare) && bare.includes("@") ? [`<${bare.replace(/^<|>$/g, "")}>`] : [];
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const ids = parseMessageIds(value);
  return ids[0] ?? null;
}

const WINDOW_MS = 30 * 24 * 3600_000;
/** Subjects too generic to group by. */
const GENERIC = new Set(["", "(no subject)", "no subject", "hi", "hello", "hallo", "test", "fyi", "question", "invoice", "rechnung"]);

export interface ThreadCandidate {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  date: number;
  from: Address | null;
  to: Address[];
  cc: Address[];
}

interface SubjectEntry {
  threadId: string;
  date: number;
  people: Set<string>;
}

/** The people of a message, lowercased, without the account's own address. */
export function participants(m: Pick<ThreadCandidate, "from" | "to" | "cc">, own: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const a of [m.from, ...m.to, ...m.cc]) {
    if (!a?.address) continue;
    const key = a.address.trim().toLowerCase();
    if (key && !own.has(key)) out.add(key);
  }
  return out;
}

/**
 * The in-memory threading index of one account: Message-ID → thread, and normalized subject →
 * recent threads with their people.
 */
export class ThreadIndex {
  readonly #byRef = new Map<string, string>();
  readonly #bySubject = new Map<string, SubjectEntry[]>();
  readonly #own: Set<string>;

  constructor(ownAddresses: Iterable<string>) {
    this.#own = new Set([...ownAddresses].map((a) => a.toLowerCase()));
  }

  /** Records a message as part of a thread. */
  add(m: ThreadCandidate, threadId: string): void {
    for (const id of [m.messageIdHeader, m.inReplyTo, ...m.references]) {
      if (id && !this.#byRef.has(id)) this.#byRef.set(id, threadId);
    }
    const subject = normalizeSubject(m.subject);
    if (GENERIC.has(subject)) return;
    let list = this.#bySubject.get(subject);
    if (!list) this.#bySubject.set(subject, (list = []));
    const people = participants(m, this.#own);
    const same = list.find((e) => e.threadId === threadId && Math.abs(e.date - m.date) < WINDOW_MS);
    if (same) {
      for (const p of people) same.people.add(p);
      same.date = Math.max(same.date, m.date);
    } else {
      list.push({ threadId, date: m.date, people });
      if (list.length > 50) list.shift();
    }
  }

  /** Threads this message's headers point at (several when it bridges two conversations). */
  byReferences(m: ThreadCandidate): string[] {
    const found: string[] = [];
    for (const id of [m.messageIdHeader, m.inReplyTo, ...[...m.references].reverse()]) {
      if (!id) continue;
      const t = this.#byRef.get(id);
      if (t && !found.includes(t)) found.push(t);
    }
    return found;
  }

  bySubject(m: ThreadCandidate): string | null {
    const subject = normalizeSubject(m.subject);
    if (GENERIC.has(subject)) return null;
    const list = this.#bySubject.get(subject);
    if (!list) return null;
    const people = participants(m, this.#own);
    let best: SubjectEntry | null = null;
    for (const e of list) {
      if (Math.abs(e.date - m.date) > WINDOW_MS) continue;
      let shared = false;
      for (const p of people) if (e.people.has(p)) shared = true;
      // Mail between the account and itself has no other participant: the subject decides.
      if (!shared && !(people.size === 0 && e.people.size === 0)) continue;
      if (!best || Math.abs(e.date - m.date) < Math.abs(best.date - m.date)) best = e;
    }
    return best?.threadId ?? null;
  }

  /**
   * The thread for a new message: references first, then the subject. `merge` lists other
   * threads the message joins together (their messages should move to `threadId`).
   */
  resolve(m: ThreadCandidate, makeId: () => string): { threadId: string; merge: string[]; isNew: boolean } {
    const refs = this.byReferences(m);
    if (refs.length > 0) return { threadId: refs[0]!, merge: refs.slice(1), isNew: false };
    const bySubject = this.bySubject(m);
    if (bySubject) return { threadId: bySubject, merge: [], isNew: false };
    return { threadId: makeId(), merge: [], isNew: true };
  }

  /** After merging `from` into `to`. */
  rename(from: string, to: string): void {
    for (const [k, v] of this.#byRef) if (v === from) this.#byRef.set(k, to);
    for (const list of this.#bySubject.values()) for (const e of list) if (e.threadId === from) e.threadId = to;
  }
}
