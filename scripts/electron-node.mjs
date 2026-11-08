#!/usr/bin/env node
// Runs a script with Electron's Node (Node 24 with node:sqlite and FTS5), the runtime the
// server ships with. Usage: node scripts/electron-node.mjs <script> [...args]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron"); // the path to the binary when required from Node

const child = spawn(electron, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
