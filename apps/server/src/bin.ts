/**
 * The server's command line. stdout carries exactly one line, the ready JSON; logs go to
 * stderr and <dataDir>/logs/server.log.
 *
 *   --data-dir <path>   required: mail.db, attachments, uploads, logs live here
 *   --port <n>          default settings.mcp.port (47821); the next 20 are tried when taken
 *   --web-dist <path>   serve the built UI from there
 *   --dev               session token from FANCY_MAIL_DEV_TOKEN; allow the Vite origin
 *   --vault-key-stdin   read {"vaultKey":"<base64 32 bytes>"} from stdin first; exit when stdin closes
 *   --no-demo           do not seed the demo accounts into a fresh database
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ServerConfig } from "./config.ts";
import { VERSION, dataPaths } from "./config.ts";
import { createLogger } from "./log.ts";
import { createMcp } from "./mcp/index.ts";
import type { Logger } from "./log.ts";
import { createServer } from "./server.ts";
import type { RunningServer } from "./server.ts";

interface Args {
  dataDir: string | null;
  port: number | null;
  webDist: string | null;
  dev: boolean;
  vaultKeyStdin: boolean;
  demo: boolean;
}

function fail(message: string): never {
  process.stderr.write(`fancy-mail-server: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dataDir: null, port: null, webDist: null, dev: false, vaultKeyStdin: false, demo: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) fail(`${flag} needs a value.`);
      return v;
    };
    switch (flag) {
      case "--data-dir":
        args.dataDir = path.resolve(value());
        break;
      case "--port": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0 || n > 65535) fail("--port must be a port number.");
        args.port = n;
        break;
      }
      case "--web-dist":
        args.webDist = path.resolve(value());
        break;
      case "--dev":
        args.dev = true;
        break;
      case "--vault-key-stdin":
        args.vaultKeyStdin = true;
        break;
      case "--no-demo":
        args.demo = false;
        break;
      default:
        fail(`unknown argument ${arg}.`);
    }
  }
  return args;
}

/** Reads the first line of stdin: {"vaultKey":"<base64>"}. */
function readVaultKeyLine(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as { vaultKey?: unknown };
        const key = typeof parsed.vaultKey === "string" ? Buffer.from(parsed.vaultKey, "base64") : Buffer.alloc(0);
        if (key.length !== 32) throw new Error("vaultKey must be 32 bytes, base64");
        resolve(key);
      } catch (error) {
        reject(error);
      }
    };
    const onEnd = () => reject(new Error("stdin closed before the vault key arrived"));
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

/** The dev/fallback key in <dataDir>/vault.key (not protected by the OS). */
function fileVaultKey(dataDir: string, log: Logger): Buffer {
  const file = dataPaths(dataDir).vaultKey;
  try {
    const key = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (key.length === 32) {
      log.warn("using the vault key from vault.key; it is not protected by the operating system");
      return key;
    }
    log.warn("vault.key is not 32 bytes; refusing to replace it");
    fail(`${file} is damaged. Move it away to start with a new key (saved passwords will need to be entered again).`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  log.warn("created vault.key; it is not protected by the operating system");
  return key;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataDir) fail("--data-dir <path> is required.");
  fs.mkdirSync(args.dataDir, { recursive: true });
  const log = createLogger({ dataDir: args.dataDir });

  let vaultKey: Buffer;
  if (args.vaultKeyStdin) {
    try {
      vaultKey = await readVaultKeyLine();
    } catch (error) {
      log.error("could not read the vault key from stdin", { error: error instanceof Error ? error.message : String(error) });
      process.exit(2);
    }
  } else {
    vaultKey = fileVaultKey(args.dataDir, log);
  }

  const devToken = args.dev ? process.env.FANCY_MAIL_DEV_TOKEN?.trim() || null : null;
  const config: ServerConfig = {
    dataDir: args.dataDir,
    port: args.port,
    host: "127.0.0.1",
    webDist: args.webDist,
    dev: args.dev,
    vaultKey,
    seedDemo: args.demo,
    sessionToken: devToken,
    version: VERSION,
  };

  let server: RunningServer;
  try {
    server = await createServer(config, { log, createMcp: ({ services, log: mcpLog }) => createMcp({ services, log: mcpLog }) });
  } catch (error) {
    log.error("could not start", { error });
    log.close();
    process.exit(1);
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      port: server.port,
      url: server.url,
      sessionToken: server.sessionToken,
      mcpUrl: server.mcpUrl,
      dataDir: server.dataDir,
    })}\n`,
  );

  let stopping = false;
  const stop = (why: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`stopping (${why})`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    server
      .close()
      .catch((error: unknown) => process.stderr.write(`close failed: ${String(error)}\n`))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  if (args.vaultKeyStdin) {
    // The parent (the desktop shell) holds our stdin; when it dies, so do we.
    process.stdin.on("end", () => stop("stdin closed"));
    process.stdin.on("close", () => stop("stdin closed"));
    process.stdin.resume();
  }
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception", { error });
  });
  process.on("unhandledRejection", (error) => {
    log.error("unhandled rejection", { error });
  });
}

void main();
