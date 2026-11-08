#!/usr/bin/env node
// Bundles the server (src/bin.ts) into one ESM file for Electron's Node.
//   node build.mjs [--outfile <path>]     default: dist/server.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--outfile");
const outfile = i >= 0 ? path.resolve(process.argv[i + 1]) : path.join(here, "dist", "server.mjs");

await build({
  entryPoints: [path.join(here, "src", "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "linked",
  // ws: optional native speedups that may be absent.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS dependencies (mailparser, imapflow, nodemailer) need require() inside ESM.
  banner: {
    js: [
      'import { createRequire as __fmCreateRequire } from "node:module";',
      "const require = __fmCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
