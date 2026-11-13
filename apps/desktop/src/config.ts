/**
 * Where things are. Production keeps everything in Electron's userData folder
 * (%APPDATA%/Fancy Mail on Windows, ~/Library/Application Support/Fancy Mail on macOS); development keeps it in the repo's .dev-data folder, and the two are
 * never mixed up: a dev run refuses to start on the installed app's folder.
 */
import { app } from "electron";
import os from "node:os";
import path from "node:path";

export const VERSION = __FANCY_MAIL_VERSION__;
export const IS_DEV = process.env.FANCY_MAIL_DEV === "1" && !app.isPackaged;
export const IS_SNAPSHOT = process.env.FANCY_MAIL_SNAPSHOT === "1" && !app.isPackaged;

/** The repo root in development (main.cjs lives in apps/desktop/dist). */
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Dev-only overrides (ignored by the installed app), used to test the shell on its own. */
function devEnv(name: string): string | undefined {
  return IS_DEV ? process.env[name] || undefined : undefined;
}

export const DEV_PORT = Number(devEnv("FANCY_MAIL_DEV_PORT") ?? 47822);
export const DEV_WEB_URL = (devEnv("FANCY_MAIL_DEV_WEB_URL") ?? "http://localhost:5190").replace(/\/+$/, "");

/** The installed app's data folder; dev and snapshot runs must never use it. */
function installedDataDir(): string {
  return path.join(app.getPath("appData"), "Fancy Mail");
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * Sets Electron's own folders before the app is ready, and returns where the mail lives.
 * - production: userData = %APPDATA%/Fancy Mail, mail in the same folder;
 * - dev: mail in <repo>/.dev-data, Chromium's profile in .dev-data/electron;
 * - snapshot: Chromium's profile in a temp folder (the server's data is the script's business).
 */
export function resolveDataDir(): string {
  if (IS_SNAPSHOT) {
    const profile = process.env.FANCY_MAIL_SNAPSHOT_PROFILE || path.join(os.tmpdir(), `fancy-mail-snapshot-profile-${process.pid}`);
    app.setPath("userData", profile);
    return profile;
  }
  if (IS_DEV) {
    const dataDir = path.resolve(devEnv("FANCY_MAIL_DEV_DATA_DIR") ?? path.join(REPO_ROOT, ".dev-data"));
    if (samePath(dataDir, installedDataDir())) {
      throw new Error(`A development run may not use the installed app's data folder (${dataDir}).`);
    }
    app.setPath("userData", path.join(dataDir, "electron"));
    return dataDir;
  }
  return app.getPath("userData");
}

/** How to start the server: the TypeScript source in dev, the bundle in the installed app. */
export function serverCommand(dataDir: string): { entry: string; args: string[] } {
  if (IS_DEV) {
    const entry = path.resolve(devEnv("FANCY_MAIL_DEV_SERVER_ENTRY") ?? path.join(REPO_ROOT, "apps", "server", "src", "bin.ts"));
    return { entry, args: ["--data-dir", dataDir, "--dev", "--port", String(DEV_PORT), "--vault-key-stdin"] };
  }
  return {
    entry: path.join(process.resourcesPath, "server", "server.mjs"),
    // The installed app starts empty (demo mail is for development and screenshots).
    args: ["--data-dir", dataDir, "--web-dist", path.join(process.resourcesPath, "web"), "--vault-key-stdin", "--no-demo"],
  };
}
