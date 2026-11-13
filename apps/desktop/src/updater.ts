/**
 * Updates from GitHub Releases, the way Fancy Dictator does it (after T3 Code's
 * apps/desktop/src/updates, MIT — see THIRD_PARTY_LICENSE_T3CODE.txt):
 *
 * - check 10 s after the start and every 4 minutes; never download on its own;
 * - the app's update button downloads, then restarts into the new version (silently);
 * - only the installed app updates; development runs report "disabled".
 *
 * The feed is the latest release's own files (…/releases/latest/download/latest.yml), which
 * change the moment a release is published; GitHub's releases list lags minutes behind.
 * While the repository is private every check fails with 404: that is reported as an "error"
 * state with a short message, never a dialog.
 *
 * The state carries both the short names the brief uses (version, percent, status "ready")
 * and the explicit ones (availableVersion, downloadedVersion, downloadPercent).
 *
 * macOS installs an update only when the new version is signed like the running one
 * (Squirrel.Mac checks it): a Developer ID or Fancy Mail's own certificate (scripts/dist.mjs).
 * A build signed ad hoc is a different app every version, so its update button opens the new
 * .dmg in the browser instead (`manual: true`); so does any Mac whose install in the app fails.
 *
 * Test builds only (scripts/mac-update-check.mjs): FANCY_MAIL_UPDATE_URL reads the feed from
 * there, and FANCY_MAIL_UPDATE_TEST=1 downloads and installs an update as soon as there is one.
 */
import { execFile } from "node:child_process";
import path from "node:path";

import { app } from "electron";

import { log } from "./log.ts";
import { openExternally } from "./window.ts";

export type UpdateStatus = "disabled" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";

export interface UpdateState {
  status: UpdateStatus;
  enabled: boolean;
  currentVersion: string;
  /** The version available or downloaded. */
  version: string | null;
  availableVersion: string | null;
  downloadedVersion: string | null;
  /** 0–100 while downloading, 100 when ready. */
  percent: number | null;
  downloadPercent: number | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  /** macOS signed ad hoc (or an install in the app failed): "download" opens the .dmg in the browser. */
  manual: boolean;
}

const RELEASES_URL = "https://github.com/OtakuGamerAds/fancy-mail/releases/latest/download";
const FEED_URL = process.env.FANCY_MAIL_UPDATE_URL || RELEASES_URL;
const AUTO_INSTALL_FOR_TEST = process.env.FANCY_MAIL_UPDATE_TEST === "1";
const STARTUP_DELAY_MS = 10_000;
const POLL_INTERVAL_MS = 4 * 60 * 1000;

let state: UpdateState = {
  status: "disabled",
  enabled: false,
  currentVersion: __FANCY_MAIL_VERSION__,
  version: null,
  availableVersion: null,
  downloadedVersion: null,
  percent: null,
  downloadPercent: null,
  message: null,
  errorContext: null,
  manual: false,
};

let notify: (state: UpdateState) => void = () => {};
let downloading = false;
let updater: typeof import("electron-updater").autoUpdater | null = null;

function setState(patch: Partial<UpdateState>): void {
  const next = { ...state, ...patch };
  next.version = next.downloadedVersion ?? next.availableVersion;
  next.percent = next.downloadPercent;
  state = next;
  notify(state);
}

/** One short line: electron-updater's errors carry the whole HTTP exchange. */
function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const statusCode = Number((error as { statusCode?: number } | null)?.statusCode ?? text.match(/\b(\d{3})\b/)?.[1]);
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNRESET|ECONNREFUSED|ETIMEDOUT|net::ERR_/.test(text) || statusCode >= 500) {
    return "Couldn't reach GitHub right now.";
  }
  if (statusCode === 404 || statusCode === 401 || statusCode === 403) return "No update information was found.";
  return (text.split(/\r?\n/)[0] ?? "").slice(0, 120);
}

function wireEvents(u: NonNullable<typeof updater>): void {
  u.on("checking-for-update", () => {
    if (state.downloadedVersion) return; // A downloaded update stays ready.
    setState({ status: "checking", message: null, errorContext: null });
  });
  u.on("update-available", (info) => {
    const isDownloaded = state.downloadedVersion === info.version;
    setState({
      status: isDownloaded ? "ready" : "available",
      availableVersion: info.version,
      downloadPercent: isDownloaded ? 100 : null,
      message: null,
      errorContext: null,
    });
  });
  u.on("update-not-available", () => {
    if (state.downloadedVersion) return setState({ status: "ready", downloadPercent: 100 });
    setState({ status: "up-to-date", availableVersion: null, downloadPercent: null, message: null, errorContext: null });
  });
  u.on("download-progress", (progress) => {
    setState({ status: "downloading", downloadPercent: Math.round(progress.percent * 10) / 10 });
  });
  u.on("update-downloaded", (info) => {
    downloading = false;
    setState({ status: "ready", downloadedVersion: info.version, downloadPercent: 100, message: null, errorContext: null });
  });
  u.on("error", (error) => {
    if (downloading) return; // download() reports it.
    if (state.downloadedVersion) return setState({ status: "ready", downloadPercent: 100 });
    setState({ status: "error", message: errorMessage(error), errorContext: "check" });
  });
}

export function getUpdateState(): UpdateState {
  return state;
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (!updater || !state.enabled || downloading || state.status === "checking") return state;
  try {
    await updater.checkForUpdates();
  } catch (error) {
    if (!state.downloadedVersion) setState({ status: "error", message: errorMessage(error), errorContext: "check" });
  }
  return state;
}

/** The release's .dmg for this Mac (scripts/dist.mjs names it Fancy-Mail-<version>-<arch>.dmg). */
function dmgUrl(version: string): string {
  return `${RELEASES_URL}/Fancy-Mail-${version}-${process.arch === "arm64" ? "arm64" : "x64"}.dmg`;
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.manual && state.enabled && state.availableVersion) {
    openExternally(dmgUrl(state.availableVersion));
    setState({ message: "The new version is downloading in your browser. Open it and drag Fancy Mail to Applications.", errorContext: null });
    return state;
  }
  if (!updater || !state.enabled || downloading || !state.availableVersion || state.downloadedVersion) return state;
  downloading = true;
  setState({ status: "downloading", downloadPercent: 0, message: null, errorContext: null });
  try {
    await updater.downloadUpdate();
  } catch (error) {
    downloading = false;
    log.warn("[updater] the download failed:", errorMessage(error));
    if (process.platform === "darwin") {
      // Squirrel.Mac refused it (most often: signed differently). The browser way still works.
      setState({ status: "available", downloadPercent: null, manual: true, message: "The update couldn't install in the app. Click to download it instead.", errorContext: "download" });
    } else {
      // Back to "available" so the button offers a retry.
      setState({ status: "available", downloadPercent: null, message: errorMessage(error), errorContext: "download" });
    }
  }
  return state;
}

/** `beforeQuit` stops the server first, so the installer finds no running Fancy Mail. */
export async function installUpdate(beforeQuit: () => Promise<void>): Promise<UpdateState> {
  if (!updater || !state.enabled || !state.downloadedVersion) return state;
  try {
    await beforeQuit();
    updater.quitAndInstall(true, true);
  } catch (error) {
    setState({ status: "error", message: errorMessage(error), errorContext: "install" });
  }
  return state;
}

/**
 * Whether this Mac app is signed by a certificate (a Developer ID or Fancy Mail's own), the
 * same one every version: only then can it install its own updates. `codesign -dv` names the
 * certificate ("Authority="); an ad hoc build has none ("Signature=adhoc").
 */
function hasStableSignature(): Promise<boolean> {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle], (error, stdout, stderr) => {
      const text = `${stdout}${stderr}`;
      resolve(!error && /^Authority=/m.test(text) && !/Signature=adhoc/.test(text));
    });
  });
}

/** `beforeInstall` stops the server (test mode installs without the button, which does it otherwise). */
export function initUpdater(onState: (state: UpdateState) => void, beforeInstall: () => Promise<void> = async () => {}): void {
  notify = onState;
  if (!app.isPackaged) return;
  if (process.platform === "darwin") {
    // Until the signature is known, updates go through the browser (the safe way).
    setState({ manual: true });
    void hasStableSignature().then((signed) => {
      log.info(signed ? "[updater] signed with a certificate: updates install in the app" : "[updater] signed ad hoc: updates download in the browser");
      setState({ manual: !signed });
    });
  }
  // Loaded only in the installed app: development never touches the update machinery.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
  updater = autoUpdater;
  autoUpdater.setFeedURL({ provider: "generic", url: FEED_URL });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (message?: unknown) => log.info("[updater]", String(message)),
    warn: (message?: unknown) => log.warn("[updater]", String(message)),
    error: (message?: unknown) => log.warn("[updater]", errorMessage(message)),
    debug: () => {},
  };
  wireEvents(autoUpdater);
  if (AUTO_INSTALL_FOR_TEST) {
    log.info(`[updater] test mode: installing any update from ${FEED_URL}`);
    autoUpdater.on("update-available", () => void downloadUpdate());
    autoUpdater.on("update-downloaded", () => void installUpdate(beforeInstall));
  }
  setState({ enabled: true, status: "idle" });
  setTimeout(() => void checkForUpdate(), STARTUP_DELAY_MS);
  setInterval(() => void checkForUpdate(), POLL_INTERVAL_MS);
}
