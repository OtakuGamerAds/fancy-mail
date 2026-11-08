#!/usr/bin/env node
// pnpm dev            the desktop app: esbuild watches the shell, Vite serves the UI, and
//                     Electron starts (it starts the server from source, data in .dev-data).
//                     Changing apps/desktop/src restarts Electron. Quitting the app stops all.
// pnpm dev:browser    no Electron: the server (from source, data in .dev-data, session token
//                     "dev") and Vite; open the printed URL in a browser.
//
// Ctrl+C stops everything this script started (only that, by PID).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ROOT,
  color,
  electronPath,
  fail,
  killTree,
  requireFreePort,
  run,
  stopAll,
  waitForExit,
  waitForPort,
  waitForReadyLine,
} from "./lib.mjs";

const BROWSER = process.argv.includes("--browser");
const VITE_PORT = 5190;
const SERVER_PORT = 47822;
const DATA_DIR = path.resolve(process.env.FANCY_MAIL_DEV_DATA_DIR || path.join(ROOT, ".dev-data"));
const VITE_BIN = path.join(ROOT, "apps", "web", "node_modules", "vite", "bin", "vite.js");
// FANCY_MAIL_DEV_SERVER_ENTRY runs another server script (to try the shell on its own).
const SERVER_ENTRY = process.env.FANCY_MAIL_DEV_SERVER_ENTRY || path.join(ROOT, "apps", "server", "src", "bin.ts");

let shuttingDown = false;

async function shutdown(code, message) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (message) console.log(`\n${message}`);
  // A server exits when its stdin closes; the rest are ended by PID after 3 s.
  await stopAll({ graceMs: 3000, polite: (child) => child.stdin?.end() });
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0, "Stopping…"));
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGHUP", () => void shutdown(0));

/** Exits the whole dev run when a process that must keep running stops. */
function essential(child, what) {
  child.on("exit", (code) => {
    if (!shuttingDown) void shutdown(1, color("red", `${what} stopped (exit code ${code}); stopping the rest.`));
  });
  return child;
}

function startVite() {
  if (!fs.existsSync(VITE_BIN)) fail("Vite isn't installed in apps/web. Run `pnpm install` first.");
  return essential(
    run("vite", process.execPath, [VITE_BIN, "--clearScreen", "false"], {
      cwd: path.join(ROOT, "apps", "web"),
      env: { FANCY_MAIL_SERVER_PORT: String(SERVER_PORT) },
    }),
    "Vite",
  );
}

async function waitForVite(vite) {
  try {
    await waitForPort(VITE_PORT, 60_000, () => vite.exitCode !== null);
  } catch (error) {
    await shutdown(1, color("red", `Vite didn't start on port ${VITE_PORT}: ${error.message}. See the [vite] lines above.`));
  }
}

/** .dev-data/vault.key: 32 random bytes in base64, created on first use (dev data only). */
function devVaultKey() {
  const file = path.join(DATA_DIR, "vault.key");
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, "utf8").trim();
    if (Buffer.from(key, "base64").length !== 32) fail(`${file} does not hold a valid key.`);
    return key;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32).toString("base64");
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

// ── pnpm dev:browser ────────────────────────────────────────────────────────────────────────

async function browser() {
  if (!fs.existsSync(SERVER_ENTRY)) fail("apps/server/src/bin.ts doesn't exist yet.");
  await requireFreePort(VITE_PORT, "Vite");
  await requireFreePort(SERVER_PORT, "the dev server");

  // The key goes in over stdin (the same .dev-data/vault.key `pnpm dev` uses), which also ties
  // the server's life to this script: if it dies, the server's stdin closes and it exits.
  const server = essential(
    run(
      "server",
      process.execPath,
      [
        path.join(ROOT, "scripts", "electron-node.mjs"),
        SERVER_ENTRY,
        "--data-dir",
        DATA_DIR,
        "--dev",
        "--port",
        String(SERVER_PORT),
        "--vault-key-stdin",
      ],
      { env: { FANCY_MAIL_DEV_TOKEN: "dev", ELECTRON_RUN_AS_NODE: undefined }, stdin: "pipe" },
    ),
    "The server",
  );
  server.stdin.on("error", () => {});
  server.stdin.write(`${JSON.stringify({ vaultKey: devVaultKey() })}\n`);
  const vite = startVite();
  try {
    await waitForReadyLine(server, 120_000);
  } catch (error) {
    await shutdown(1, color("red", `The server didn't start: ${error.message}. See the [server] lines above.`));
  }
  await waitForVite(vite);
  console.log(`\n  ${color("green", "Open")} http://localhost:${VITE_PORT}/?t=dev#/inbox\n  Data: ${DATA_DIR}\n  Ctrl+C stops the server and Vite.\n`);
}

// ── pnpm dev ────────────────────────────────────────────────────────────────────────────────

async function desktop() {
  if (!fs.existsSync(SERVER_ENTRY)) fail("apps/server/src/bin.ts doesn't exist yet.");
  await requireFreePort(VITE_PORT, "Vite");
  await requireFreePort(SERVER_PORT, "the dev server");

  // The shell's bundles: the first build gates Electron, later ones restart it.
  let built = new Set();
  let firstBuild;
  const firstBuildDone = new Promise((resolve) => (firstBuild = resolve));
  let restartTimer = null;
  const watcher = essential(
    run("desktop", process.execPath, [path.join(ROOT, "apps", "desktop", "build.mjs"), "--watch"], {
      onLine: (line) => {
        const match = line.match(/built (main|preload)\.cjs/);
        if (!match) return;
        if (built) {
          built.add(match[1]);
          if (built.size === 2) {
            built = null;
            firstBuild();
          }
          return;
        }
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => void restartElectron(), 400);
      },
    }),
    "The desktop build watcher",
  );
  const vite = startVite();

  const first = await Promise.race([firstBuildDone.then(() => true), waitForExit(watcher, 60_000).then(() => false)]);
  if (!first) await shutdown(1, color("red", "The desktop shell didn't build. See the [desktop] lines above."));
  await waitForVite(vite);

  let electron = null;
  let restarting = false;
  const startElectron = () => {
    electron = run("electron", electronPath(), [path.join(ROOT, "apps", "desktop", "dist", "main.cjs")], {
      env: { FANCY_MAIL_DEV: "1", ELECTRON_RUN_AS_NODE: undefined },
    });
    const self = electron;
    self.on("exit", (code) => {
      if (shuttingDown || restarting || electron !== self) return;
      void shutdown(code ? 1 : 0, code ? color("red", `Electron exited with code ${code}.`) : "Fancy Mail closed; stopping Vite and the watcher.");
    });
  };
  const restartElectron = async () => {
    if (shuttingDown || !electron) return;
    console.log(color("yellow", "\n[dev] the shell changed; restarting Electron\n"));
    restarting = true;
    killTree(electron);
    await waitForExit(electron, 5000);
    restarting = false;
    if (!shuttingDown) startElectron();
  };
  startElectron();
  console.log(`\n  ${color("green", "Fancy Mail (dev)")} is starting. Data: ${DATA_DIR}\n  Ctrl+C stops everything.\n`);
}

(BROWSER ? browser() : desktop()).catch((error) => shutdown(1, color("red", String(error?.stack ?? error))));
