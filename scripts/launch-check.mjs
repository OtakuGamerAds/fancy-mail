#!/usr/bin/env node
// Opens a packaged Fancy Mail the way a person would and checks that it comes up: its server
// reports ready and the window shows. Like T3 Code's scripts/smoke-desktop-app.ts (MIT
// License — see THIRD_PARTY_LICENSE_T3CODE.txt), the release jobs run it so a build that
// can't start is never published. On macOS it also takes a screenshot of the screen.
//
//   node scripts/launch-check.mjs --app "release/mac-arm64/Fancy Mail.app" [--out launch-check]
//
// Only for a throwaway machine (CI): the app uses its real data folder there. On a computer
// with Fancy Mail installed it refuses to run, so it never touches someone's mail.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { fail, waitForExit } from "./lib.mjs";

const READY_TIMEOUT_MS = 120_000;
const { values } = parseArgs({ options: { app: { type: "string" }, out: { type: "string" } } });
if (!values.app) fail('Usage: node scripts/launch-check.mjs --app "<Fancy Mail.app or win-unpacked folder>" [--out <dir>]');
if (!process.env.CI) fail("This runs the packaged app on its real data folder, so it only runs in CI (CI=true).");

const app = path.resolve(values.app);
const out = path.resolve(values.out ?? "launch-check");
const isMac = process.platform === "darwin";
const executable = isMac ? path.join(app, "Contents", "MacOS", "Fancy Mail") : path.join(app, "Fancy Mail.exe");
const dataDir = isMac ? path.join(os.homedir(), "Library", "Application Support", "Fancy Mail") : path.join(process.env.APPDATA ?? "", "Fancy Mail");
const desktopLog = path.join(dataDir, "logs", "desktop.log");
if (!fs.existsSync(executable)) fail(`${executable} doesn't exist.`);
if (fs.existsSync(dataDir)) fail(`${dataDir} already exists: this machine has Fancy Mail data, so the check doesn't run here.`);
fs.mkdirSync(out, { recursive: true });

const readLog = () => (fs.existsSync(desktopLog) ? fs.readFileSync(desktopLog, "utf8") : "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`▸ Opening ${path.basename(app)}`);
const child = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

let failure = null;
try {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!/server ready on /.test(readLog())) {
    if (child.exitCode !== null) throw new Error(`the app quit (exit code ${child.exitCode}) before its server was ready`);
    if (Date.now() > deadline) throw new Error(`its server wasn't ready within ${READY_TIMEOUT_MS / 1000} s`);
    await sleep(500);
  }
  console.log("✓ the app's server is ready");
  // Time for the window to load the app and show.
  await sleep(8000);
  if (child.exitCode !== null) throw new Error(`the app quit (exit code ${child.exitCode}) after starting`);
  if (/the window could not load the app|page stopped/.test(readLog())) throw new Error("the window couldn't load the app");
  console.log("✓ the window loaded the app");
} catch (error) {
  failure = error;
}

if (isMac) {
  const shot = path.join(out, "screen.png");
  const result = spawnSync("screencapture", ["-x", shot]);
  console.log(result.status === 0 ? `▸ screenshot: ${shot}` : "(no screenshot: screencapture failed)");
}

// Quit the normal way (the app stops its server), then make sure it is gone.
child.kill("SIGTERM");
if (!(await waitForExit(child, 15_000))) {
  console.log("(the app didn't quit within 15 s; ending it)");
  child.kill("SIGKILL");
  await waitForExit(child, 5000);
}
if (fs.existsSync(path.join(dataDir, "logs"))) fs.cpSync(path.join(dataDir, "logs"), path.join(out, "logs"), { recursive: true });
fs.writeFileSync(path.join(out, "output.txt"), output);

if (failure) {
  console.error(readLog().split(/\r?\n/).slice(-30).join("\n"));
  fail(`The launch check failed: ${failure.message}`);
}
console.log("✓ the app opened, showed its window and quit cleanly");
