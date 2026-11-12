import path from "node:path";

export const VERSION: string = process.env.FANCY_MAIL_VERSION || "0.1.0";

/** The Vite dev server's origin; allowed for HTTP and WebSocket checks only with --dev. */
export const VITE_DEV_ORIGIN = "http://localhost:5190";
export const VITE_DEV_PORT = 5190;

export interface ServerConfig {
  /** Everything lives here: mail.db, attachments/, uploads/, logs/, vault.key. */
  dataDir: string;
  /** null: settings.mcp.port, and the next 20 ports when it is taken. */
  port: number | null;
  /** Always 127.0.0.1: the server never listens on other interfaces. */
  host: string;
  /** The built web UI to serve; null in dev (Vite serves it). */
  webDist: string | null;
  dev: boolean;
  /** 32 bytes for the credentials vault (AES-256-GCM). */
  vaultKey: Buffer;
  /** Seed the demo accounts into a database created fresh. */
  seedDemo: boolean;
  /** Fixed session token (dev: FANCY_MAIL_DEV_TOKEN); null: a random one per start. */
  sessionToken: string | null;
  version: string;
}

export function dataPaths(dataDir: string) {
  return {
    db: path.join(dataDir, "mail.db"),
    attachments: path.join(dataDir, "attachments"),
    demoAttachments: path.join(dataDir, "attachments", "demo"),
    uploads: path.join(dataDir, "uploads"),
    logs: path.join(dataDir, "logs"),
    vaultKey: path.join(dataDir, "vault.key"),
    /** What agents read to connect (mcp/guide.ts). */
    agent: path.join(dataDir, "agent"),
  };
}

export type DataPaths = ReturnType<typeof dataPaths>;
