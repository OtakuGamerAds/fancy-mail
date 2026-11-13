#!/usr/bin/env node
// Bundles the server (apps/server/src/bin.ts and everything it imports, npm packages
// included) into one ES module the installed app runs with Electron's Node:
//
//   apps/desktop/dist/server/server.mjs
//
//   node scripts/build-server.mjs           build
//   node scripts/build-server.mjs --smoke   build, then start the bundle on a temp folder,
//                                           wait for its ready line and stop it again
import fs from "node:fs";
import path from "node:path";

import { ROOT, electronPath, fail, requireFrom, smokeServer } from "./lib.mjs";

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
  try {
    const ready = await smokeServer({ executable: electronPath(), entry: OUT });
    console.log(`[server] the bundle starts: ready on ${ready.url}, and stops when its stdin closes`);
  } catch (error) {
    fail(`The bundled server didn't start: ${error.message}`);
  }
}
