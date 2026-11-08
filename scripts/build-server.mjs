#!/usr/bin/env node
// Bundles the server (apps/server/src/bin.ts and everything it imports, npm packages
// included) into one ES module the installed app runs with Electron's Node:
//
//   apps/desktop/dist/server/server.mjs
//
//   node scripts/build-server.mjs           build
//   node scripts/build-server.mjs --smoke   build, then start the bundle on a temp folder,
//                                           wait for its ready line and stop it again
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT, electronPath, fail, killTree, requireFrom, rootVersion, waitForExit, waitForReadyLine } from "./lib.mjs";

const ENTRY = path.join(ROOT, "apps", "server", "src", "bin.ts");
const OUT_DIR = path.join(ROOT, "apps", "desktop", "dist", "server");
const OUT = path.join(OUT_DIR, "server.mjs");

if (!fs.existsSync(ENTRY)) fail("apps/server/src/bin.ts doesn't exist yet.");
const esbuild = requireFrom("apps/desktop", "esbuild");

fs.rmSync(OUT_DIR, { recursive: true, force: true });
const started = Date.now();
try {
  const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // CommonJS packages call require(), __dirname and __filename; an ES module has none.
    // `require` is declared once (esbuild renames a module's own `require`); __dirname and
    // __filename are replaced only where a module doesn't declare its own.
    banner: {
      js: [
        'import { createRequire as __fmCreateRequire } from "node:module";',
        'import { fileURLToPath as __fmFileURLToPath } from "node:url";',
        'import { dirname as __fmDirname } from "node:path";',
        "const require = __fmCreateRequire(import.meta.url);",
        "const __fm_filename = __fmFileURLToPath(import.meta.url);",
        "const __fm_dirname = __fmDirname(__fm_filename);",
      ].join("\n"),
    },
    define: { __dirname: "__fm_dirname", __filename: "__fm_filename" },
    // ws's optional native speed-ups; it works without them.
    external: ["bufferutil", "utf-8-validate"],
    define: { "process.env.FANCY_MAIL_BUNDLED": '"1"' },
    sourcemap: "linked",
    minify: false,
    keepNames: true,
    legalComments: "linked",
    metafile: true,
    logLevel: "warning",
  });
  const bytes = fs.statSync(OUT).size;
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(`[server] built ${path.relative(ROOT, OUT)} (${(bytes / 1024 / 1024).toFixed(1)} MB from ${inputs} files) in ${Date.now() - started} ms`);
} catch {
  fail("The server bundle failed (see the errors above).");
}

// Files the server reads at run time from next to its sources would be missing from the
// bundle: copy apps/server/assets (if there is one) along.
const assets = path.join(ROOT, "apps", "server", "assets");
if (fs.existsSync(assets)) {
  fs.cpSync(assets, path.join(OUT_DIR, "assets"), { recursive: true });
  console.log("[server] copied apps/server/assets");
}

if (process.argv.includes("--smoke")) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-bundle-smoke-"));
  const child = spawn(electronPath(), [OUT, "--data-dir", dataDir, "--port", "47859", "--no-demo", "--vault-key-stdin"], {
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
    console.log(`[server] the bundle starts: ready on ${ready.url}`);
  } catch (error) {
    console.error(stderr.split(/\r?\n/).slice(-20).join("\n"));
    killTree(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fail(`The bundled server didn't start: ${error.message}`);
  }
  child.stdin.end();
  if (!(await waitForExit(child, 5000))) {
    console.error("[server] the bundle didn't stop when its stdin closed; ending it");
    killTree(child);
    await waitForExit(child, 2000);
  } else {
    console.log("[server] the bundle stops when its stdin closes");
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
