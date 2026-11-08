/**
 * The shell's own log, <dataDir>/logs/desktop.log (the server's output goes to
 * desktop-server.log next to it). Never pass secrets here: no tokens, no keys.
 */
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
let file: string | null = null;
let echo = true;

/** Keeps one previous log (`.old`) once a log grows past 5 MB. */
export function rotate(target: string): void {
  try {
    if (fs.statSync(target).size > MAX_BYTES) fs.renameSync(target, `${target}.old`);
  } catch {
    // Missing: nothing to rotate.
  }
}

export function initLog(logDir: string, toConsole: boolean): void {
  fs.mkdirSync(logDir, { recursive: true });
  file = path.join(logDir, "desktop.log");
  rotate(file);
  echo = toConsole;
}

function write(level: string, parts: unknown[]): void {
  const text = parts
    .map((part) => (part instanceof Error ? (part.stack ?? part.message) : typeof part === "string" ? part : JSON.stringify(part)))
    .join(" ");
  const line = `${new Date().toISOString()} ${level} ${text}\n`;
  if (echo) (level === "ERROR" ? process.stderr : process.stdout).write(`[shell] ${text}\n`);
  if (!file) return;
  try {
    fs.appendFileSync(file, line);
  } catch {
    // A full or locked disk must not take the app down.
  }
}

export const log = {
  info: (...parts: unknown[]) => write("INFO", parts),
  warn: (...parts: unknown[]) => write("WARN", parts),
  error: (...parts: unknown[]) => write("ERROR", parts),
};
