#!/usr/bin/env node
// pnpm dist: builds the installer for Windows or macOS into release/.
//   1. the web UI        (apps/web → apps/web/dist)
//   2. the server bundle (apps/server → apps/desktop/dist/server/server.mjs)
//   3. the shell         (apps/desktop/src → apps/desktop/dist/*.cjs)
//   4. electron-builder  (apps/desktop/electron-builder.json, plus what differs per platform)
//
//   pnpm dist                          this computer's platform and arch
//   pnpm dist --platform mac --arch x64
//   pnpm dist --dir                    an unpacked app only (no installer)
//   pnpm dist --smoke                  then start the packaged app's server (when this computer can run it)
//
// Like T3 Code's scripts/build-desktop-artifact.ts (MIT License — see
// THIRD_PARTY_LICENSE_T3CODE.txt), one script builds every platform; a Mac build has to run on
// a Mac (GitHub Actions does it, .github/workflows/release.yml).
//
//   Windows  Fancy-Mail-Setup-<version>.exe, its .blockmap, latest.yml
//   macOS    Fancy-Mail-<version>-<arch>.dmg (to install) and .zip (+ .blockmap, for updates),
//            latest-mac.yml
//
// A Mac build is signed with the Developer ID in CSC_LINK / CSC_KEY_PASSWORD and notarized with
// APPLE_API_KEY (the .p8 file's path) / APPLE_API_KEY_ID / APPLE_API_ISSUER when all of them
// are set; otherwise it is signed ad hoc, which runs after the person allows it once (README).
//
// The version is the root package.json's. Other arguments go to electron-builder.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ROOT, fail, readJson, rootVersion, smokeServer } from "./lib.mjs";

const PLATFORMS = { win32: "win", darwin: "mac" };
// Signing settings that are set but empty (CI passes secrets that don't exist as "") would be
// read as a certificate path; without signing, none of them may reach electron-builder.
const SIGNING_ENV = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
const version = rootVersion();
const electronVersion = readJson(path.join(ROOT, "node_modules", "electron", "package.json")).version;

// ── Arguments ───────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function take(name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  args.splice(at, 2);
  return value;
}
function flag(name) {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}

const platform = take("--platform") ?? PLATFORMS[process.platform];
const arch = take("--arch") ?? process.arch;
const smoke = flag("--smoke");
const dirOnly = args.includes("--dir");
const extra = args;
if (platform !== "win" && platform !== "mac") fail(`Can't build for "${platform ?? process.platform}": use --platform win or --platform mac.`);
if (arch !== "x64" && arch !== "arm64") fail(`Can't build for the "${arch}" architecture: use --arch x64 or --arch arm64.`);
if (platform === "mac" && process.platform !== "darwin") fail("A Mac build needs a Mac (dmg and code signing are macOS tools). GitHub Actions builds it on release.");

const signMac = platform === "mac" && SIGNING_ENV.every((name) => process.env[name]);

// ── The electron-builder config: the shared file plus what this build needs ─────────────────

function buildConfig() {
  const config = readJson(path.join(ROOT, "apps", "desktop", "electron-builder.json"));
  // The Electron that pnpm installed fits only this computer; anything else is downloaded.
  const installed = path.join(ROOT, "node_modules", "electron", "dist");
  if (PLATFORMS[process.platform] === platform && process.arch === arch && fs.existsSync(installed)) {
    config.electronDist = installed;
  }
  if (platform === "mac") {
    config.mac = signMac
      ? // Developer ID (from CSC_LINK), hardened runtime with electron-builder's entitlements, notarized.
        { ...config.mac, hardenedRuntime: true, notarize: true }
      : // Ad hoc: Apple Silicon runs only signed code. No hardened runtime (it would need entitlements
        // a Developer ID brings).
        { ...config.mac, identity: "-", hardenedRuntime: false, notarize: false };
  }
  const file = path.join(ROOT, "apps", "desktop", "dist", "electron-builder.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

// ── Build ───────────────────────────────────────────────────────────────────────────────────

function step(title, command, commandArgs, options = {}) {
  console.log(`\n▸ ${title}`);
  const env = { ...process.env, ...options.env };
  for (const name of SIGNING_ENV) if (!env[name] || !signMac) delete env[name];
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: "inherit", shell: options.shell ?? false, env });
  if (result.status !== 0) fail(`${title} failed (exit code ${result.status ?? result.signal}).`);
}

step("Building the web UI", "pnpm", ["--filter", "@fancy-mail/web", "build"], { shell: true });
if (!fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html"))) fail("apps/web/dist/index.html is missing after the web build.");

step("Bundling the server", process.execPath, [path.join(ROOT, "scripts", "build-server.mjs")]);
step("Building the desktop shell", process.execPath, [path.join(ROOT, "apps", "desktop", "build.mjs")]);

const config = buildConfig();
const label = platform === "mac" ? `macOS ${arch}${signMac ? ", signed and notarized" : ", signed ad hoc"}` : `Windows ${arch}`;
step(
  `Packaging Fancy Mail ${version} for ${label} (Electron ${electronVersion})`,
  process.execPath,
  [
    path.join(ROOT, "apps", "desktop", "node_modules", "electron-builder", "cli.js"),
    "--projectDir",
    path.join(ROOT, "apps", "desktop"),
    "--config",
    config,
    `--${platform}`,
    `--${arch}`,
    "--publish",
    "never",
    `-c.extraMetadata.version=${version}`,
    `-c.electronVersion=${electronVersion}`,
    ...extra,
  ],
  // Without a Developer ID, electron-builder must not go looking for one in the keychain.
  platform === "mac" && !signMac ? { env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" } } : {},
);

// ── What it made ────────────────────────────────────────────────────────────────────────────

const release = (...parts) => path.join(ROOT, "release", ...parts);
const unpacked = platform === "win" ? release(arch === "x64" ? "win-unpacked" : `win-${arch}-unpacked`) : release(arch === "x64" ? "mac" : `mac-${arch}`, "Fancy Mail.app");
const outputs = dirOnly
  ? [unpacked]
  : platform === "win"
    ? [release(`Fancy-Mail-Setup-${version}.exe`), release(`Fancy-Mail-Setup-${version}.exe.blockmap`), release("latest.yml")]
    : [
        release(`Fancy-Mail-${version}-${arch}.dmg`),
        release(`Fancy-Mail-${version}-${arch}.zip`),
        release(`Fancy-Mail-${version}-${arch}.zip.blockmap`),
        release("latest-mac.yml"),
      ];
for (const file of outputs) if (!fs.existsSync(file)) fail(`${path.relative(ROOT, file)} is missing.`);
console.log("");
for (const file of outputs) {
  const size = fs.statSync(file).isFile() ? ` (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)` : "";
  console.log(`✓ ${path.relative(ROOT, file)}${size}`);
}

// The packaged app's own binary runs its own bundled server, as it will on the person's computer.
if (smoke) {
  if (PLATFORMS[process.platform] !== platform || process.arch !== arch) {
    console.log(`\n(No smoke check: this computer can't run a ${label} app.)`);
  } else {
    const executable = platform === "win" ? path.join(unpacked, "Fancy Mail.exe") : path.join(unpacked, "Contents", "MacOS", "Fancy Mail");
    const resources = platform === "win" ? path.join(unpacked, "resources") : path.join(unpacked, "Contents", "Resources");
    console.log("\n▸ Starting the packaged app's server");
    try {
      const ready = await smokeServer({ executable, entry: path.join(resources, "server", "server.mjs"), args: ["--web-dist", path.join(resources, "web")] });
      console.log(`✓ the packaged server starts (ready on ${ready.url}) and stops`);
    } catch (error) {
      fail(`The packaged app's server didn't start: ${error.message}`);
    }
  }
}
