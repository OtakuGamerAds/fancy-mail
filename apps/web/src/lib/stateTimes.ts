/**
 * The times offered for "Wait for an answer" and "Snooze", and how a time left reads on a row.
 * Waiting counts in days (you'd follow up in the morning); snoozing in hours and days.
 */

export interface TimeChoice {
  id: string;
  label: string;
  /** When, in words: "Thu, Nov 19". */
  detail: string;
  until: number;
}

function atHour(day: Date, hour: number): number {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function daysFrom(now: number, days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return d;
}

/** "Thu, Nov 19", with the time when it isn't the morning: "Today, 18:00". */
export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, today)) return `Today, ${time}`;
  if (sameDay(d, daysFrom(now, 1))) return d.getHours() === 9 && d.getMinutes() === 0 ? "Tomorrow" : `Tomorrow, ${time}`;
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return d.getHours() === 9 && d.getMinutes() === 0 ? day : `${day}, ${time}`;
}

/** How long until then, short: "5d", "3h", "20m", "now". */
export function formatLeft(ms: number, now = Date.now()): string {
  const left = ms - now;
  if (left <= 60_000) return "now";
  const minutes = Math.round(left / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(left / 3_600_000);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(left / 86_400_000)}d`;
}

/** Waiting for an answer: in 3 days, a week, two weeks, a month (in the morning). */
export function waitChoices(now = Date.now()): TimeChoice[] {
  const month = new Date(now);
  month.setMonth(month.getMonth() + 1);
  const choices = [
    { id: "3d", label: "3 days", until: atHour(daysFrom(now, 3), 9) },
    { id: "1w", label: "1 week", until: atHour(daysFrom(now, 7), 9) },
    { id: "2w", label: "2 weeks", until: atHour(daysFrom(now, 14), 9) },
    { id: "1m", label: "1 month", until: atHour(month, 9) },
  ];
  return choices.map((c) => ({ ...c, detail: formatDay(c.until) }));
}

/** "Thu, Nov 19", with the time unless it's 09:00: "Fri, Nov 13, 18:00". */
function formatDay(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (d.getHours() === 9 && d.getMinutes() === 0) return day;
  return `${day}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Snoozing: this evening (while it's still ahead), tomorrow morning, the weekend, next week. */
export function snoozeChoices(now = Date.now()): TimeChoice[] {
  const today = new Date(now);
  const out: Omit<TimeChoice, "detail">[] = [];
  // Later today: this evening while it's ahead, a few hours on in the evening, nothing at night.
  if (today.getHours() < 16) out.push({ id: "evening", label: "This evening", until: atHour(today, 18) });
  else if (today.getHours() < 20) out.push({ id: "later", label: "In 3 hours", until: now + 3 * 3_600_000 });
  out.push({ id: "tomorrow", label: "Tomorrow", until: atHour(daysFrom(now, 1), 9) });
  const weekday = today.getDay(); // 0 Sunday … 6 Saturday
  if (weekday >= 1 && weekday <= 4) out.push({ id: "weekend", label: "This weekend", until: atHour(daysFrom(now, 6 - weekday), 9) });
  out.push({ id: "week", label: "Next week", until: atHour(daysFrom(now, ((8 - weekday) % 7) || 7), 9) });
  return out.map((c) => ({ ...c, detail: formatDay(c.until) }));
}
