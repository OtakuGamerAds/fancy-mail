/** Dates and sizes the way the list, the reader and Activity show them. */

const pad = (n: number) => String(n).padStart(2, "0");

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const EXACT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The list's date: today "14:05", this year "Nov 3", older "2025-11-03". */
export function formatListDate(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  if (sameDay(d, today)) return formatTime(at);
  if (d.getFullYear() === today.getFullYear()) return MONTH_DAY.format(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Sat, Nov 7, 2026, 14:05" — the exact time, shown on hover. */
export function formatExact(at: number): string {
  return EXACT.format(new Date(at));
}

/** "Just now", "5 min ago", "3 h ago", "Yesterday, 18:20", "Nov 3, 09:10", "2025-11-03". */
export function formatRelative(at: number, now = Date.now()): string {
  const diff = now - at;
  const minutes = Math.floor(diff / 60_000);
  if (diff >= 0 && minutes < 1) return "Just now";
  if (diff >= 0 && minutes < 60) return `${minutes} min ago`;
  const d = new Date(at);
  const today = new Date(now);
  if (diff >= 0 && sameDay(d, today)) {
    const hours = Math.floor(minutes / 60);
    return hours < 6 ? `${hours} h ago` : `Today, ${formatTime(at)}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday, ${formatTime(at)}`;
  if (d.getFullYear() === today.getFullYear()) return `${MONTH_DAY.format(d)}, ${formatTime(at)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Short relative time for compact places: "now", "5m", "3h", "2d", "Nov 3". */
export function formatAgoShort(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return formatListDate(at, now);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatCount(n: number): string {
  if (n >= 10_000) return `${Math.floor(n / 1000)}k`;
  return n.toLocaleString();
}
