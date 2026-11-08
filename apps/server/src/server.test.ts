import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { silentLogger } from "./log.ts";
import { createServer } from "./server.ts";
import { createLocalOnlySync } from "./sync/localOnly.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function start(dataDir: string, seedDemo: boolean) {
  return createServer(
    { dataDir, port: 0, host: "127.0.0.1", webDist: null, dev: false, vaultKey: Buffer.alloc(32, 7), seedDemo, sessionToken: null, version: "test" },
    { createSync: createLocalOnlySync, log: silentLogger() },
  );
}

describe("demo mail and the installed app", () => {
  it("starts empty, and removes demo mail an earlier version put in, once", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-server-test-"));
    dirs.push(dataDir);

    // An earlier version (or development) seeded demo mail.
    let server = await start(dataDir, true);
    expect(server.services.demo.hasDemoData()).toBe(true);
    await server.close();

    // The installed app (--no-demo) removes it on start.
    server = await start(dataDir, false);
    expect(server.services.demo.hasDemoData()).toBe(false);
    expect(server.store.accounts.list()).toHaveLength(0);
    expect(server.store.groups.list()).toHaveLength(0);
    expect(server.store.labels.list()).toHaveLength(0);
    // Demo mail brought back on purpose stays: the clean-up happens once.
    server.services.demo.seed();
    await server.close();

    server = await start(dataDir, false);
    expect(server.services.demo.hasDemoData()).toBe(true);
    await server.close();
  });

  it("a fresh installed app has no accounts at all", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-server-test-"));
    dirs.push(dataDir);
    const server = await start(dataDir, false);
    expect(server.store.accounts.list()).toHaveLength(0);
    expect(server.services.demo.hasDemoData()).toBe(false);
    await server.close();
  });
});
