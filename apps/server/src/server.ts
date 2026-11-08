/**
 * Wires the server: database, store, services, sync engine, HTTP and WebSocket. `createServer`
 * resolves once it listens; `close()` shuts everything down in order.
 */
import fs from "node:fs";
import type { AddressInfo } from "node:net";

import type { ServerConfig } from "./config.ts";
import { dataPaths } from "./config.ts";
import { migrate } from "./db/migrations.ts";
import { openDb } from "./db/sqlite.ts";
import type { Db } from "./db/sqlite.ts";
import { createLogger } from "./log.ts";
import type { Logger } from "./log.ts";
import { createEventBus } from "./services/bus.ts";
import { createServices } from "./services/index.ts";
import type { Services } from "./services/index.ts";
import { createVault } from "./services/vault.ts";
import { createStore } from "./store/index.ts";
import type { Store } from "./store/index.ts";
import { createSyncEngine } from "./sync/engine.ts";
import type { CreateSync, SyncEngine } from "./sync/types.ts";
import { createAuth } from "./transport/auth.ts";
import { createHttpServer } from "./transport/http.ts";
import type { McpHandler } from "./transport/http.ts";
import { createWsServer } from "./transport/ws.ts";

export interface McpMount {
  handler: McpHandler;
  close?(): void | Promise<void>;
}

export interface CreateServerOptions {
  /** The sync engine (default: the real one; demo accounts are served by its local-only part). */
  createSync?: CreateSync;
  /** Mounts /mcp (the MCP module provides it). */
  createMcp?: (deps: { services: Services; config: ServerConfig; log: Logger }) => McpMount | Promise<McpMount>;
  log?: Logger;
  /** Clock for the services (tests). */
  now?: () => number;
}

export interface RunningServer {
  port: number;
  url: string;
  mcpUrl: string;
  sessionToken: string;
  dataDir: string;
  services: Services;
  store: Store;
  db: Db;
  sync: SyncEngine;
  setMcpHandler(handler: McpHandler | null): void;
  close(): Promise<void>;
}

const PORT_TRIES = 21;

export async function createServer(config: ServerConfig, options: CreateServerOptions = {}): Promise<RunningServer> {
  const paths = dataPaths(config.dataDir);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(paths.attachments, { recursive: true });
  fs.mkdirSync(paths.uploads, { recursive: true });
  const log = options.log ?? createLogger({ dataDir: config.dataDir });
  log.addSecret(config.vaultKey.toString("base64"));

  const db = openDb(paths.db);
  let closed = false;
  try {
    const migration = migrate(db);
    if (migration.from !== migration.to) log.info("database migrated", { from: migration.from, to: migration.to });

    const store = createStore(db);
    const bus = createEventBus((error) => log.error("event subscriber failed", { error }));
    const vault = createVault(db, config.vaultKey);
    const services = createServices({ db, store, bus, vault, log, dataDir: config.dataDir, version: config.version, now: options.now });
    log.addSecret(services.mcp.currentToken());

    if (migration.fresh && config.seedDemo) {
      const started = Date.now();
      const summary = services.demo.seed();
      log.info("seeded the demo accounts", { ...summary, ms: Date.now() - started });
    }

    const sync = (options.createSync ?? createSyncEngine)({ db, store, services, bus, vault, config, log: log.child("sync") });
    services.attachSync(sync);

    const auth = createAuth({ token: config.sessionToken, dev: config.dev });
    log.addSecret(auth.token);
    const http = createHttpServer({ services, auth, config, log: log.child("http") });
    const ws = createWsServer({ services, auth, log: log.child("ws"), dev: config.dev });
    http.server.on("upgrade", (req, socket, head) => {
      if (!ws.handleUpgrade(req, socket, head)) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
      }
    });

    const firstPort = config.port ?? services.settings.get().mcp.port;
    const port = await listen(http.server, config.host, firstPort, log);
    auth.setPort(port);
    services.setPort(port);
    sync.start();

    let mcp: McpMount | null = null;
    if (options.createMcp) {
      mcp = await options.createMcp({ services, config, log: log.child("mcp") });
      http.setMcpHandler(mcp.handler);
    }

    try {
      const removed = services.uploads.cleanup();
      if (removed > 0) log.info("removed old uploads", { count: removed });
    } catch (error) {
      log.warn("could not clean up uploads", { error });
    }

    const url = `http://127.0.0.1:${port}`;
    log.info("listening", { url, dataDir: config.dataDir, dev: config.dev });

    return {
      port,
      url,
      mcpUrl: `${url}/mcp`,
      sessionToken: auth.token,
      dataDir: config.dataDir,
      services,
      store,
      db,
      sync,
      setMcpHandler: (handler) => http.setMcpHandler(handler),
      async close() {
        if (closed) return;
        closed = true;
        log.info("closing");
        http.setMcpHandler(null);
        try {
          await mcp?.close?.();
        } catch (error) {
          log.warn("MCP close failed", { error });
        }
        await ws.close();
        await new Promise<void>((resolve) => {
          http.server.close(() => resolve());
          http.server.closeAllConnections();
        });
        try {
          await sync.stop();
        } catch (error) {
          log.warn("sync stop failed", { error });
        }
        db.close();
        log.info("closed");
        log.close();
      },
    };
  } catch (error) {
    if (!closed) db.close();
    throw error;
  }
}

/** Listens on `first`, or the next ports when it is taken. */
function listen(server: import("node:http").Server, host: string, first: number, log: Logger): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = first;
    let tries = 0;
    const attempt = () => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && ++tries < PORT_TRIES && port !== 0) {
          log.warn("port in use, trying the next one", { port });
          port++;
          attempt();
        } else {
          reject(error.code === "EADDRINUSE" ? new Error(`Ports ${first}–${port} are all in use. Close the other program or pass --port.`) : error);
        }
      };
      const onListening = () => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    };
    attempt();
  });
}
