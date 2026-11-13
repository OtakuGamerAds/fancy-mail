// Bundles the desktop shell with esbuild:
//   src/main.ts    → dist/main.cjs     (the main process; icons are embedded)
//   src/preload.ts → dist/preload.cjs  (the window's bridge, runs sandboxed)
//
//   node apps/desktop/build.mjs            one build (minified, no source maps)
//   node apps/desktop/build.mjs --dev      one build with source maps
//   node apps/desktop/build.mjs --watch    rebuild on change (dev; implies --dev)
//
// The version shown in the app is the root package.json's: `electron dist/main.cjs` alone
// would report Electron's own version.
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const here = import.meta.dirname;
const root = path.join(here, "..", "..");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");
// FANCY_MAIL_BUILD_VERSION: a test build's own version (scripts/mac-update-check.mjs).
const version = process.env.FANCY_MAIL_BUILD_VERSION || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

/** Logs each finished build (the dev script restarts Electron on "built"). */
const report = {
  name: "report",
  setup(build) {
    let started = 0;
    build.onStart(() => {
      started = Date.now();
    });
    build.onEnd((result) => {
      const out = path.basename(build.initialOptions.outfile);
      if (result.errors.length) console.error(`[desktop] ${out} failed with ${result.errors.length} error(s)`);
      else console.log(`[desktop] built ${out} in ${Date.now() - started} ms`);
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "electron-updater"],
  sourcemap: dev ? "linked" : false,
  minify: !dev,
  keepNames: true,
  logLevel: "warning",
  loader: { ".png": "binary" },
  define: {
    __FANCY_MAIL_VERSION__: JSON.stringify(version),
  },
  plugins: [report],
};

const targets = [
  { ...common, entryPoints: [path.join(here, "src", "main.ts")], outfile: path.join(here, "dist", "main.cjs") },
  { ...common, entryPoints: [path.join(here, "src", "preload.ts")], outfile: path.join(here, "dist", "preload.cjs") },
];

if (watch) {
  for (const options of targets) {
    const context = await esbuild.context(options);
    await context.watch();
  }
  console.log("[desktop] watching apps/desktop/src");
} else {
  try {
    await Promise.all(targets.map((options) => esbuild.build(options)));
  } catch {
    process.exit(1);
  }
}
