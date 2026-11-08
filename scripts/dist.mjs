#!/usr/bin/env node
// pnpm dist: builds the Windows installer into release/.
//   1. the web UI        (apps/web → apps/web/dist)
//   2. the server bundle (apps/server → apps/desktop/dist/server/server.mjs)
//   3. the shell         (apps/desktop/src → apps/desktop/dist/*.cjs)
//   4. electron-builder  (apps/desktop/electron-builder.json)
// The version is the root package.json's. Extra arguments go to electron-builder
// (e.g. `pnpm dist --dir` for an unpacked app in release/win-unpacked, no installer).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ROOT, fail, readJson, rootVersion } from "./lib.mjs";

const version = rootVersion();
const electronVersion = readJson(path.join(ROOT, "node_modules", "electron", "package.json")).version;
const extra = process.argv.slice(2);

function step(title, command, args, options = {}) {
  console.log(`\n▸ ${title}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", shell: options.shell ?? false, env: { ...process.env, ...options.env } });
  if (result.status !== 0) fail(`${title} failed (exit code ${result.status ?? result.signal}).`);
}

step("Building the web UI", "pnpm", ["--filter", "@fancy-mail/web", "build"], { shell: true });
if (!fs.existsSync(path.join(ROOT, "apps", "web", "dist", "index.html"))) fail("apps/web/dist/index.html is missing after the web build.");

step("Bundling the server", process.execPath, [path.join(ROOT, "scripts", "build-server.mjs")]);
step("Building the desktop shell", process.execPath, [path.join(ROOT, "apps", "desktop", "build.mjs")]);

step(
  `Packaging Fancy Mail ${version} (Electron ${electronVersion})`,
  process.execPath,
  [
    path.join(ROOT, "apps", "desktop", "node_modules", "electron-builder", "cli.js"),
    "--projectDir",
    path.join(ROOT, "apps", "desktop"),
    "--config",
    "electron-builder.json",
    "--win",
    "--publish",
    "never",
    `-c.extraMetadata.version=${version}`,
    `-c.electronVersion=${electronVersion}`,
    ...extra,
  ],
);

const installer = path.join(ROOT, "release", `Fancy-Mail-Setup-${version}.exe`);
if (!extra.includes("--dir")) {
  if (!fs.existsSync(installer)) fail(`${path.relative(ROOT, installer)} is missing.`);
  console.log(`\n✓ ${path.relative(ROOT, installer)} (${(fs.statSync(installer).size / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.log(`\n✓ release/win-unpacked/Fancy Mail.exe`);
}
