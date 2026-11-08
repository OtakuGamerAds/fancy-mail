/**
 * Runs the local mail server as a child process with Electron's own Node
 * (ELECTRON_RUN_AS_NODE), and keeps it running.
 *
 * - The vault key goes in as the first stdin line; stdin then stays open. The server exits by
 *   itself when stdin closes, so it never outlives the app, even after a crash.
 * - The server reports `{"type":"ready",…}` as one stdout line; until then it is "starting".
 * - If it exits unexpectedly it is started again after 1 s, 2 s, 5 s, then every 10 s. A
 *   server that stayed up for a minute starts the count from the beginning.
 * - Stopping closes stdin, waits up to 3 s, then ends the process by its PID.
 *
 * Its stderr and any other output go to <dataDir>/logs/desktop-server.log (and the console in
 * dev). The ready line carries the session token, so it is never logged as is.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";

import { log, rotate } from "./log.ts";

export interface ServerReady {
  port: number;
  url: string;
  sessionToken: string;
  mcpUrl: string;
  dataDir: string;
}

export interface ServerDown {
  /** One line about why, safe to show (the server's last error line, or exit code). */
  reason: string;
  /** When the next start is due, in ms. */
  retryInMs: number;
  attempt: number;
}

export interface ServerOptions {
  entry: string;
  args: string[];
  env: Record<string, string>;
  vaultKey: Buffer;
  logFile: string;
  echo: boolean;
  onReady: (ready: ServerReady, restart: boolean) => void;
  onDown: (down: ServerDown) => void;
}

const RESTART_DELAYS_MS = [1000, 2000, 5000];
const RESTART_DELAY_MAX_MS = 10_000;
/** The first start may seed the demo data or migrate a large database. */
const READY_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 3000;
/** A server that stayed up this long restarts quickly again next time. */
const STABLE_AFTER_MS = 60_000;

const ERROR_LINE = /error|fatal|fail|cannot|can't|exception|denied|refused|in use|locked|EADDRINUSE|EACCES|EPERM|ENOENT/i;

function parseReady(line: string): ServerReady | null {
  if (!line.startsWith("{")) return null;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type !== "ready") return null;
    const { port, url, sessionToken, mcpUrl, dataDir } = value;
    if (typeof port !== "number" || typeof url !== "string" || typeof sessionToken !== "string") return null;
    return {
      port,
      url: url.replace(/\/+$/, ""),
      sessionToken,
      mcpUrl: typeof mcpUrl === "string" ? mcpUrl : `${url}/mcp`,
      dataDir: typeof dataDir === "string" ? dataDir : "",
    };
  } catch {
    return null;
  }
}

/** Splits a stream into lines, without letting one endless line eat memory. */
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
    }
    if (buffer.length > 1_000_000) {
      onLine(buffer);
      buffer = "";
    }
  });
  stream.on("end", () => {
    if (buffer) onLine(buffer);
    buffer = "";
  });
}

export class ServerSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private current: ServerReady | null = null;
  private stopping = false;
  private everReady = false;
  private attempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private readyAt = 0;
  private lastErrorLine = "";
  private readonly options: ServerOptions;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  /** The running server, or null while it starts or is down. */
  get ready(): ServerReady | null {
    return this.current;
  }

  /** The PID of the server process we started (for logs and tests). */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.stopping || this.child) return;
    this.restartTimer = null;
    const { entry, args, env, vaultKey, logFile, echo } = this.options;
    rotate(logFile);
    const out = fs.createWriteStream(logFile, { flags: "a" });
    out.on("error", () => {});
    const write = (line: string) => {
      out.write(`${line}\n`);
      if (echo) process.stderr.write(`[server] ${line}\n`);
    };
    write(`── ${new Date().toISOString()} starting the server (${args.filter((a) => a.startsWith("--")).join(" ")})`);

    if (!fs.existsSync(entry)) {
      write(`The server entry is missing: ${entry}`);
      out.end();
      this.handleExit(`The server's files are missing (${entry}).`);
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [entry, ...args], {
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      write(`Could not start the server: ${String(error)}`);
      out.end();
      this.handleExit("Could not start the server process.");
      return;
    }
    this.child = child;
    log.info(`server started (pid ${child.pid})`);

    child.stdin.on("error", () => {
      // EPIPE when the server exits first; the exit handler deals with it.
    });
    child.stdin.write(`${JSON.stringify({ vaultKey: vaultKey.toString("base64") })}\n`);

    lines(child.stdout, (line) => {
      const ready = parseReady(line);
      if (ready) {
        this.onReadyLine(child, ready);
        write(`ready on ${ready.url}`);
        return;
      }
      if (line.trim()) write(line);
    });
    lines(child.stderr, (line) => {
      if (!line.trim()) return;
      // The server logs to stderr too; remember the last line that reads like a failure.
      if (ERROR_LINE.test(line)) this.lastErrorLine = line.trim().slice(0, 300);
      write(line);
    });

    this.readyTimer = setTimeout(() => {
      if (this.child !== child || this.current) return;
      write(`The server did not report ready within ${READY_TIMEOUT_MS / 1000} s; stopping it.`);
      this.lastErrorLine = "The server took too long to start.";
      child.kill();
    }, READY_TIMEOUT_MS);

    child.on("error", (error) => {
      write(`Server process error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      write(`── server exited (${signal ? `signal ${signal}` : `code ${code}`})`);
      out.end();
      if (this.child !== child) return;
      this.child = null;
      this.current = null;
      if (this.stopping) return;
      const reason = this.lastErrorLine || `The server stopped (exit code ${code ?? signal}).`;
      this.handleExit(reason);
    });
  }

  private onReadyLine(child: ChildProcessWithoutNullStreams, ready: ServerReady): void {
    if (this.child !== child) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.current = ready;
    this.readyAt = Date.now();
    this.lastErrorLine = "";
    const restart = this.everReady;
    this.everReady = true;
    log.info(`server ready on ${ready.url}${restart ? " (after a restart)" : ""}`);
    this.options.onReady(ready, restart);
  }

  private handleExit(reason: string): void {
    if (this.readyAt && Date.now() - this.readyAt >= STABLE_AFTER_MS) this.attempt = 0;
    this.readyAt = 0;
    const delay = RESTART_DELAYS_MS[this.attempt] ?? RESTART_DELAY_MAX_MS;
    this.attempt += 1;
    log.warn(`server down: ${reason} — starting again in ${delay / 1000} s (attempt ${this.attempt})`);
    this.options.onDown({ reason, retryInMs: delay, attempt: this.attempt });
    this.restartTimer = setTimeout(() => this.start(), delay);
  }

  /** Starts again now (the status page's "Try again"). */
  retryNow(): void {
    if (this.child || this.stopping) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.start();
  }

  /** Stops for good: close stdin, wait up to 3 s, then end the process we started. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), STOP_GRACE_MS));
    if ((await Promise.race([exited, timer])) === "timeout") {
      log.warn(`server did not stop within ${STOP_GRACE_MS / 1000} s; ending pid ${child.pid}`);
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    this.child = null;
    this.current = null;
    log.info("server stopped");
  }
}
