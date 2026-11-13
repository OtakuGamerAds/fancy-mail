// Small helpers shared by the dev, snapshot and dist scripts: running child processes with
// prefixed output, checking and waiting for ports, and stopping only what we started.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const IS_WINDOWS = process.platform === "win32";

const require = createRequire(import.meta.url);

/** The Electron binary (the `electron` package exports its path when required from Node). */
export function electronPath() {
  try {
    return require("electron");
  } catch {
    fail("Electron isn't installed. Run `pnpm install` in the repo first.");
  }
}

/** A module installed in one of the workspace packages (e.g. esbuild in apps/desktop). */
export function requireFrom(workspaceDir, id) {
  return createRequire(path.join(ROOT, workspaceDir, "package.json"))(id);
}

export function fail(message) {
  console.error(`\n${color("red", "✗")} ${message}\n`);
  process.exit(1);
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────

const COLORS = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export function color(name, text) {
  return useColor ? `\x1b[${COLORS[name]}m${text}\x1b[0m` : text;
}

const TAG_COLORS = { desktop: "cyan", vite: "blue", electron: "magenta", server: "green", shell: "yellow", snapshot: "cyan", web: "blue" };

/** Writes each line of a stream with a `[name]` prefix (a line that has its own tag keeps it). */
export function pipeLines(stream, name, out = process.stdout, onLine = () => {}) {
  let buffer = "";
  stream.setEncoding("utf8");
  const emit = (line) => {
    onLine(line);
    // The ready line carries the session token: show where, not the token.
    if (line.startsWith('{"type":"ready"')) {
      try {
        line = `ready on ${JSON.parse(line).url}`;
      } catch {
        // Print it as is.
      }
    }
    const own = line.match(/^\[([a-z-]+)\] ?(.*)$/);
    const tag = own ? own[1] : name;
    const text = own ? own[2] : line;
    out.write(`${color(TAG_COLORS[tag] ?? "gray", `[${tag}]`)} ${text}\n`);
  };
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      emit(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
    }
  });
  stream.on("end", () => {
    if (buffer) emit(buffer);
    buffer = "";
  });
}

// ── Processes ───────────────────────────────────────────────────────────────────────────────

const started = new Set();

/**
 * Starts a process whose output is prefixed with `name`. It is remembered so `stopAll` can
 * end it (by its PID, with its children) when the script stops.
 */
export function run(name, command, args, options = {}) {
  const env = { ...process.env, FORCE_COLOR: useColor ? "1" : "0", ...options.env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env,
    stdio: [options.stdin ?? "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.label = name;
  started.add(child);
  child.on("exit", () => started.delete(child));
  child.on("error", (error) => console.error(`${color("red", `[${name}]`)} could not start: ${error.message}`));
  pipeLines(child.stdout, name, process.stdout, options.onLine);
  pipeLines(child.stderr, name, process.stderr, options.onLine);
  return child;
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

/** Waits for a process to exit; resolves false after `ms`. */
export function waitForExit(child, ms) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Ends a process we started and its children, by its PID. */
export function killTree(child) {
  if (!child.pid || exited(child)) return;
  if (IS_WINDOWS) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

/**
 * Stops everything this script started: first politely (`polite` per child, e.g. closing a
 * server's stdin), then after `graceMs` by PID.
 */
export async function stopAll({ graceMs = 3000, polite } = {}) {
  const children = [...started];
  for (const child of children) {
    try {
      if (polite) polite(child);
      else if (!IS_WINDOWS) child.kill("SIGINT");
    } catch {
      // Already gone.
    }
  }
  await Promise.all(children.map((child) => waitForExit(child, graceMs)));
  for (const child of children) killTree(child);
  await Promise.all(children.map((child) => waitForExit(child, 2000)));
}

// ── Ports ───────────────────────────────────────────────────────────────────────────────────

/** Whether nothing listens on `port` (checked on IPv4 and IPv6 loopback). */
export async function portIsFree(port) {
  const tryListen = (host) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (error) => resolve(error.code !== "EADDRINUSE" && error.code !== "EACCES"));
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
    });
  return (await tryListen("127.0.0.1")) && (await tryListen("::1"));
}

export async function requireFreePort(port, what) {
  if (!(await portIsFree(port))) {
    fail(
      `Port ${port} (${what}) is already in use. Another \`pnpm dev\` or \`pnpm snapshot\` may still be running — stop it (or whatever uses the port) and try again.`,
    );
  }
}

/** Resolves when something accepts connections on 127.0.0.1:`port`; rejects after `ms`. */
export function waitForPort(port, ms, isDead = () => false) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (isDead()) return reject(new Error("the process exited"));
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`nothing answered on port ${port} within ${Math.round(ms / 1000)} s`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

/** The first stdout line `{"type":"ready",…}` of a server process, or a rejection. */
export function waitForReadyLine(child, ms) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`the server didn't report ready within ${Math.round(ms / 1000)} s`)), ms);
    const onData = (chunk) => {
      buffer += chunk;
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.startsWith("{")) continue;
        try {
          const value = JSON.parse(line);
          if (value.type === "ready") {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            resolve(value);
            return;
          }
        } catch {
          // Not JSON yet (or a partial line).
        }
      }
      const last = buffer.lastIndexOf("\n");
      if (last !== -1) buffer = buffer.slice(last + 1);
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited (code ${code}) before it was ready`));
    });
  });
}

/**
 * Starts a bundled server (server.mjs) the way the installed app does — `executable` (Electron,
 * or the packaged app's own binary) run as Node, the vault key on stdin — on a temp data folder.
 * Resolves with its ready line once it is up and has stopped again when its stdin closed;
 * rejects with the reason (its last stderr lines are printed).
 */
export async function smokeServer({ executable, entry, args = [] }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-smoke-"));
  const child = spawn(executable, [entry, "--data-dir", dataDir, "--port", "47859", "--no-demo", "--vault-key-stdin", ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", FANCY_MAIL_VERSION: rootVersion() },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.write(`${JSON.stringify({ vaultKey: crypto.randomBytes(32).toString("base64") })}\n`);
  try {
    const ready = await waitForReadyLine(child, 60_000);
    child.stdin.end();
    if (!(await waitForExit(child, 5000))) throw new Error("it didn't stop when its stdin closed");
    return ready;
  } catch (error) {
    console.error(stderr.split(/\r?\n/).slice(-20).join("\n"));
    throw error;
  } finally {
    killTree(child);
    await waitForExit(child, 2000);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export const rootVersion = () => readJson(path.join(ROOT, "package.json")).version;
