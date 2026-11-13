#!/usr/bin/env node
// CI, macOS: proves a Mac update works the way a person meets it, end to end.
//   1. builds this version (A) and a newer test version (B), both signed with the same
//      certificate (FANCY_MAIL_MAC_SIGN_IDENTITY, scripts/ci/mac-signing-setup.sh);
//   2. checks both carry the same designated requirement (macOS sees one app, not two);
//   3. installs A in ~/Applications, opens it (it makes its Keychain key) with its update feed
//      pointed at B on a local server, and lets it update itself (FANCY_MAIL_UPDATE_TEST=1:
//      download and install without a click);
//   4. waits for B to start by itself and open its saved key. A Keychain dialog would stop it
//      there, so B reaching "server ready" is the proof that no password is asked.
// Only for a throwaway machine (it uses the real data folder and ~/Applications).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { ROOT, fail, rootVersion } from "./lib.mjs";

if (!process.env.CI || process.platform !== "darwin") fail("This runs only in CI on a Mac (CI=true).");
if (!process.env.FANCY_MAIL_MAC_SIGN_IDENTITY) fail("FANCY_MAIL_MAC_SIGN_IDENTITY isn't set: run scripts/ci/mac-signing-setup.sh first.");

const arch = process.arch === "arm64" ? "arm64" : "x64";
const versionA = rootVersion();
const [major, minor, patch] = versionA.split("-")[0].split(".").map(Number);
const versionB = `${major}.${minor}.${patch + 1}`;
const dataDir = path.join(os.homedir(), "Library", "Application Support", "Fancy Mail");
const desktopLog = path.join(dataDir, "logs", "desktop.log");
const installed = path.join(os.homedir(), "Applications", "Fancy Mail.app");
const out = path.join(ROOT, "mac-update-check");
const PORT = 47950;
if (fs.existsSync(dataDir)) fail(`${dataDir} already exists: not a fresh machine.`);
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLog = () => (fs.existsSync(desktopLog) ? fs.readFileSync(desktopLog, "utf8") : "");

function build(version, into) {
  console.log(`\n▸ Building ${version}`);
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "dist.mjs"), "--platform", "mac", "--arch", arch], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, FANCY_MAIL_BUILD_VERSION: version },
  });
  if (result.status !== 0) fail(`The ${version} build failed.`);
  fs.rmSync(into, { recursive: true, force: true });
  fs.renameSync(path.join(ROOT, "release"), into);
}

const appIn = (dir) => path.join(dir, arch === "x64" ? "mac" : `mac-${arch}`, "Fancy Mail.app");
/** codesign's view of an app: who signed it and the requirement an update must meet. */
function signature(app) {
  const info = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", app], { encoding: "utf8" });
  const requirement = spawnSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8" });
  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  return {
    authority: `${info.stdout}${info.stderr}`.match(/^Authority=(.*)$/m)?.[1] ?? null,
    requirement: `${requirement.stdout}${requirement.stderr}`.match(/designated => (.*)$/m)?.[1] ?? null,
    valid: verify.status === 0,
    verifyOutput: `${verify.stdout}${verify.stderr}`.trim(),
  };
}

build(versionA, path.join(ROOT, "release-a"));
build(versionB, path.join(ROOT, "release-b"));

console.log("\n▸ Signatures");
const sigA = signature(appIn(path.join(ROOT, "release-a")));
const sigB = signature(appIn(path.join(ROOT, "release-b")));
console.log(`A ${versionA}: ${JSON.stringify(sigA)}`);
console.log(`B ${versionB}: ${JSON.stringify(sigB)}`);
if (!sigA.valid || !sigB.valid) fail("A build's signature doesn't verify.");
if (!sigA.authority?.startsWith("Fancy Mail")) fail(`Not signed with Fancy Mail's certificate (authority: ${sigA.authority}).`);
if (!sigA.requirement || sigA.requirement !== sigB.requirement) fail("The two versions have different designated requirements: macOS would see two apps.");
if (/cdhash/.test(sigA.requirement)) fail("The designated requirement is a cdhash (ad hoc): it changes with every build.");
console.log("✓ both versions are signed with the same certificate and requirement");

console.log("\n▸ Installing A and serving B as its update");
fs.mkdirSync(path.dirname(installed), { recursive: true });
fs.rmSync(installed, { recursive: true, force: true });
execFileSync("/usr/bin/ditto", [appIn(path.join(ROOT, "release-a")), installed]);
const feed = path.join(ROOT, "release-b");
const server = http
  .createServer((req, res) => {
    const file = path.join(feed, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    if (!file.startsWith(feed) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    console.log(`[feed] ${req.method} ${path.basename(file)}`);
    res.writeHead(200, { "content-length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1");

const app = spawn(path.join(installed, "Contents", "MacOS", "Fancy Mail"), [], {
  env: { ...process.env, FANCY_MAIL_UPDATE_URL: `http://127.0.0.1:${PORT}`, FANCY_MAIL_UPDATE_TEST: "1" },
  stdio: "ignore",
  detached: true,
});
app.unref();

let failure = null;
try {
  const deadline = Date.now() + 6 * 60_000;
  let stage = "A starting";
  for (;;) {
    const log = readLog();
    if (stage === "A starting" && /server ready on /.test(log)) {
      stage = "A updating";
      console.log(`✓ A ${versionA} started and made its Keychain key; waiting for it to update itself`);
    }
    const startB = log.indexOf(`Fancy Mail ${versionB} starting`);
    if (startB !== -1 && stage !== "done") {
      if (stage !== "B starting") console.log(`✓ B ${versionB} was installed and started by itself`);
      stage = "B starting";
      if (/server ready on /.test(log.slice(startB))) {
        stage = "done";
        break;
      }
      if (/can't unlock its saved passwords|VaultKey/.test(log.slice(startB))) throw new Error("B couldn't open its Keychain key");
    }
    if (Date.now() > deadline) throw new Error(`stuck at "${stage}"`);
    await sleep(1000);
  }
  console.log(`✓ B opened its saved key without asking (no Keychain dialog) and its server is ready`);
  const shown = spawnSync("/usr/bin/defaults", ["read", path.join(installed, "Contents", "Info"), "CFBundleShortVersionString"], { encoding: "utf8" }).stdout.trim();
  if (shown !== versionB) throw new Error(`~/Applications holds ${shown}, not ${versionB}`);
  console.log(`✓ ~/Applications/Fancy Mail.app is now ${shown}`);
} catch (error) {
  failure = error;
}

spawnSync("/usr/bin/screencapture", ["-x", path.join(out, "screen.png")]);
spawnSync("/usr/bin/osascript", ["-e", 'quit app "Fancy Mail"']);
await sleep(5000);
server.close();
if (fs.existsSync(path.join(dataDir, "logs"))) fs.cpSync(path.join(dataDir, "logs"), path.join(out, "logs"), { recursive: true });
console.log("\n--- desktop.log ---\n" + readLog().split("\n").slice(-60).join("\n"));
if (failure) fail(`The Mac update check failed: ${failure.message}`);
console.log("\n✓ The Mac update works: same signature, installed in the app, no Keychain password");
