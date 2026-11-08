/**
 * A tiny logger: one line per entry to stderr and to <dataDir>/logs/server.log (rotated at
 * 5 MB, one old file kept). stdout is reserved for the ready line.
 *
 * Secrets never reach a log: fields whose name looks like a credential are replaced, and any
 * string registered with `addSecret` (session token, MCP token, vault key) is scrubbed from
 * every line.
 */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger whose lines start with `scope:`. */
  child(scope: string): Logger;
  /** Scrub this exact string from every line from now on. */
  addSecret(secret: string): void;
  close(): void;
}

const MAX_BYTES = 5 * 1024 * 1024;
const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|vault.?key|api.?key|credential|ciphertext/i;
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** null: stderr only (tests). */
  dataDir: string | null;
  level?: LogLevel;
  /** Mirror to stderr (default true). */
  stderr?: boolean;
}

function redactValue(key: string, value: unknown, depth: number): unknown {
  if (SECRET_KEY.test(key) && value !== null && value !== undefined && value !== "") return "[redacted]";
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  if (depth > 4) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue("", v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const minLevel = LEVELS[options.level ?? (process.env.FANCY_MAIL_LOG_LEVEL as LogLevel | undefined) ?? "info"] ?? 20;
  const toStderr = options.stderr ?? true;
  const secrets = new Set<string>();
  let fd: number | null = null;
  let size = 0;
  let file: string | null = null;

  if (options.dataDir) {
    const dir = path.join(options.dataDir, "logs");
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "server.log");
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    fd = fs.openSync(file, "a");
  }

  function rotate(): void {
    if (!file || fd === null) return;
    try {
      fs.closeSync(fd);
      fs.renameSync(file, `${file}.1`);
    } catch {
      // Another process may hold the old file; keep appending to a fresh one.
    }
    fd = fs.openSync(file, "a");
    size = 0;
  }

  function scrub(line: string): string {
    let out = line;
    for (const secret of secrets) {
      if (secret.length >= 6) out = out.split(secret).join("[redacted]");
    }
    return out;
  }

  function write(level: LogLevel, scope: string | null, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < minLevel) return;
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope ? `${scope}: ` : ""}${message}`;
    if (fields && Object.keys(fields).length > 0) {
      try {
        line += ` ${JSON.stringify(redactValue("", fields, 0))}`;
      } catch {
        line += " {unserializable}";
      }
    }
    line = `${scrub(line)}\n`;
    if (toStderr) process.stderr.write(line);
    if (fd !== null) {
      try {
        const bytes = Buffer.byteLength(line);
        if (size + bytes > MAX_BYTES) rotate();
        fs.writeSync(fd, line);
        size += bytes;
      } catch {
        // Logging must never take the server down.
      }
    }
  }

  function make(scope: string | null): Logger {
    return {
      debug: (m, f) => write("debug", scope, m, f),
      info: (m, f) => write("info", scope, m, f),
      warn: (m, f) => write("warn", scope, m, f),
      error: (m, f) => write("error", scope, m, f),
      child: (s) => make(scope ? `${scope}.${s}` : s),
      addSecret: (secret) => {
        if (secret) secrets.add(secret);
      },
      close: () => {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {
            // already closed
          }
          fd = null;
        }
      },
    };
  }

  return make(null);
}

/** A logger that drops everything (tests). */
export function silentLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    addSecret: noop,
    close: noop,
  };
  return logger;
}
