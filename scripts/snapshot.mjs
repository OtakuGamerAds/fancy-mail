#!/usr/bin/env node
// pnpm snapshot: renders the main views to snapshots/latest/<name>.png for a visual check.
//
//   1. builds the web UI (skip with --no-build) and the desktop shell;
//   2. starts the server from source on a fresh temp folder (so the demo data is seeded),
//      serving apps/web/dist;
//   3. resolves the routes in scripts/snapshot-routes.json against the demo data over the
//      server's WebSocket (group, label and account ids, a newsletter, the agent's draft);
//   4. runs Electron in snapshot mode: a 1440×900 window that loads each route, waits until
//      the page settles and captures it.
//
//   pnpm snapshot                  every route
//   pnpm snapshot inbox palette    only these routes
//   pnpm snapshot --no-build       reuse apps/web/dist as it is
//   pnpm snapshot --resolve-only   only start the server and print the resolved routes
//
// Everything it started is stopped, and the temp folders removed, when it ends.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { ROOT, color, electronPath, fail, killTree, readJson, requireFrom, rootVersion, run, waitForExit, waitForReadyLine } from "./lib.mjs";

const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith("--"));
const OUT_DIR = path.join(ROOT, "snapshots", "latest");
const WEB_DIST = path.join(ROOT, "apps", "web", "dist");
const SERVER_ENTRY = path.join(ROOT, "apps", "server", "src", "bin.ts");
const ELECTRON_TIMEOUT_MS = 5 * 60 * 1000;

const temp = {
  data: fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-snapshot-data-")),
  profile: fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-snapshot-profile-")),
};
let server = null;
let electron = null;

async function cleanup() {
  if (electron) killTree(electron);
  if (server && server.exitCode === null) {
    server.stdin.end(); // The server exits by itself when its stdin closes.
    if (!(await waitForExit(server, 3000))) killTree(server);
    await waitForExit(server, 2000);
  }
  for (const dir of Object.values(temp)) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300)); // Files still closing.
      }
    }
  }
}

async function stop(code, message) {
  if (message) console.error(`\n${color(code ? "red" : "green", code ? "✗" : "✓")} ${message}`);
  await cleanup();
  process.exit(code);
}
process.on("SIGINT", () => void stop(130, "Stopped."));

function step(title, command, commandArgs, options = {}) {
  console.log(color("cyan", `▸ ${title}`));
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: "inherit", shell: options.shell ?? false });
  if (result.status !== 0) throw new Error(`${title} failed (exit code ${result.status ?? result.signal}).`);
}

/** A port nothing uses right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ── RPC over the server's WebSocket ─────────────────────────────────────────────────────────

function connect(ready) {
  const WebSocket = requireFrom("apps/server", "ws");
  const socket = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`, {
    headers: { "x-fancy-mail-session": ready.sessionToken, origin: ready.url },
  });
  const pending = new Map();
  let nextId = 1;
  socket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    const waiter = message && message.id !== undefined ? pending.get(message.id) : null;
    if (!waiter) return; // An event.
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(`${waiter.method}: ${message.error?.message ?? "failed"}`));
  });
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", (error) => reject(new Error(`couldn't connect to ${ready.url}/ws: ${error.message}`)));
    socket.once("unexpected-response", (_req, res) => reject(new Error(`the server refused the WebSocket (HTTP ${res.statusCode})`)));
  });
  return {
    opened,
    close: () => socket.close(),
    call(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 30_000);
        pending.set(id, {
          method,
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error)),
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

/** Replaces each {placeholder} in the route hashes with an id from the demo data. */
async function resolveRoutes(rpc, routes) {
  const bootstrap = await rpc.call("app.bootstrap");
  const byName = (list, name, what) => {
    const found = list.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new Error(`no ${what} named "${name}" (have: ${list.map((i) => i.name).join(", ") || "none"})`);
    return found.id;
  };
  const resolvers = {
    group: (name) => byName(bootstrap.groups, name, "group"),
    label: (name) => byName(bootstrap.labels, name, "label"),
    account: (value) => {
      const accounts = bootstrap.accounts;
      const found = value === "first" ? accounts[0] : accounts.find((a) => a.email.toLowerCase() === value.toLowerCase());
      if (!found) throw new Error(`no account ${value} (have: ${accounts.map((a) => a.email).join(", ") || "none"})`);
      return found.id;
    },
    thread: async (queries) => {
      for (const query of queries.split("||").map((q) => q.trim())) {
        const result = await rpc.call("threads.search", { query, limit: 1 });
        if (result.threads[0]) return result.threads[0].id;
      }
      throw new Error(`no conversation matches ${queries}`);
    },
    agentDraftThread: async () => {
      const drafts = await rpc.call("drafts.list");
      const isAgent = (draft) => draft.threadId && (draft.createdBy?.kind === "agent" || draft.createdBy?.type === "agent");
      const draft = drafts.find(isAgent) ?? drafts.find((d) => d.threadId);
      if (!draft) throw new Error("no draft in a conversation");
      return draft.threadId;
    },
  };

  const resolved = [];
  for (const route of routes) {
    try {
      let hash = route.hash;
      for (const match of [...route.hash.matchAll(/\{(\w+)(?::([^}]*))?\}/g)]) {
        const [whole, kind, value = ""] = match;
        const resolver = resolvers[kind];
        if (!resolver) throw new Error(`unknown placeholder ${whole}`);
        hash = hash.replace(whole, encodeURIComponent(await resolver(value)));
      }
      resolved.push({ ...route, hash });
    } catch (error) {
      console.error(color("yellow", `[snapshot] skipping ${route.name}: ${error.message}`));
    }
  }
  return resolved;
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(SERVER_ENTRY)) await stop(1, "apps/server/src/bin.ts doesn't exist yet.");
  const { routes: allRoutes } = readJson(path.join(ROOT, "scripts", "snapshot-routes.json"));
  const routes = only.length ? allRoutes.filter((r) => only.includes(r.name)) : allRoutes;
  if (!routes.length) await stop(1, `No route is called ${only.join(", ")}. See scripts/snapshot-routes.json.`);

  const resolveOnly = args.includes("--resolve-only");
  if (!resolveOnly) {
    if (!args.includes("--no-build")) step("Building the web UI", "pnpm", ["--filter", "@fancy-mail/web", "build"], { shell: true });
    if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) await stop(1, "apps/web/dist/index.html is missing. Build the web UI first.");
    step("Building the desktop shell", process.execPath, [path.join(ROOT, "apps", "desktop", "build.mjs"), "--dev"]);
  }

  console.log(color("cyan", "▸ Starting the server on a fresh folder (demo data)"));
  const port = await freePort();
  server = spawn(
    electronPath(),
    [SERVER_ENTRY, "--data-dir", temp.data, "--port", String(port), ...(resolveOnly ? [] : ["--web-dist", WEB_DIST]), "--vault-key-stdin"],
    {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1", FANCY_MAIL_VERSION: rootVersion() },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let serverLog = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => (serverLog = (serverLog + chunk).slice(-20_000)));
  server.stdout.setEncoding("utf8");
  server.stdin.on("error", () => {});
  server.stdin.write(`${JSON.stringify({ vaultKey: crypto.randomBytes(32).toString("base64") })}\n`);
  let ready;
  try {
    ready = await waitForReadyLine(server, 120_000);
  } catch (error) {
    console.error(serverLog.split(/\r?\n/).slice(-25).join("\n"));
    return stop(1, `The server didn't start: ${error.message}`);
  }
  console.log(`[snapshot] server ready on ${ready.url}`);

  const rpc = connect(ready);
  let resolved;
  try {
    await rpc.opened;
    resolved = await resolveRoutes(rpc, routes);
  } catch (error) {
    return stop(1, `Couldn't look up the demo data: ${error.message}`);
  } finally {
    rpc.close();
  }
  const skipped = routes.length - resolved.length;
  if (resolveOnly) {
    for (const route of resolved) console.log(`  ${route.name.padEnd(18)} ${route.hash}${route.click ? `  (click ${route.click})` : ""}`);
    return stop(skipped ? 1 : 0, `${resolved.length} route(s) resolved, ${skipped} skipped`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of fs.readdirSync(OUT_DIR)) {
    const name = file.replace(/\.png$/, "");
    if (file.endsWith(".png") && (!only.length || only.includes(name))) fs.rmSync(path.join(OUT_DIR, file));
  }
  const planFile = path.join(temp.profile, "plan.json");
  fs.writeFileSync(
    planFile,
    JSON.stringify({ url: ready.url, token: ready.sessionToken, outDir: OUT_DIR, width: 1440, height: 900, routes: resolved }),
  );

  console.log(color("cyan", `▸ Capturing ${resolved.length} view(s)`));
  electron = run("electron", electronPath(), [path.join(ROOT, "apps", "desktop", "dist", "main.cjs")], {
    env: {
      FANCY_MAIL_SNAPSHOT: "1",
      FANCY_MAIL_SNAPSHOT_PLAN: planFile,
      FANCY_MAIL_SNAPSHOT_PROFILE: path.join(temp.profile, "electron"),
      FANCY_MAIL_DEV: undefined,
      ELECTRON_RUN_AS_NODE: undefined,
    },
  });
  const finished = await waitForExit(electron, ELECTRON_TIMEOUT_MS);
  if (!finished) return stop(1, `Electron didn't finish within ${ELECTRON_TIMEOUT_MS / 60000} minutes.`);
  const code = electron.exitCode;
  electron = null;
  const written = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".png")).length;
  if (code !== 0 || skipped) {
    return stop(1, `${written} snapshot(s) in snapshots/latest; ${skipped} skipped, Electron exit code ${code}.`);
  }
  return stop(0, `${written} snapshot(s) in snapshots/latest`);
}

main().catch((error) => stop(1, String(error?.stack ?? error)));
