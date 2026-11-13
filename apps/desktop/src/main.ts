/**
 * Fancy Mail — the desktop shell.
 *
 * It starts the local mail server (apps/server) with Electron's own Node, hands it the vault
 * key, and shows the web app the server (or Vite, in dev) serves. It adds what a browser
 * can't: the tray, notifications, opening attachments with their program, and updates.
 *
 * Windows and macOS share all of it; where a Mac app behaves differently it follows T3 Code
 * (apps/desktop/src/app/DesktopLifecycle.ts, window/DesktopApplicationMenu.ts; MIT License —
 * see THIRD_PARTY_LICENSE_T3CODE.txt): an app menu, no tray (the Dock), and closing the window
 * keeps Fancy Mail running until Quit.
 *
 *   FANCY_MAIL_DEV=1        development: data in <repo>/.dev-data, the server from source,
 *                           the UI from Vite on http://localhost:5190
 *   FANCY_MAIL_SNAPSHOT=1   render views to PNGs and quit (scripts/snapshot.mjs)
 */
import { BrowserWindow, Menu, app, dialog, ipcMain, session, type MenuItemConstructorOptions } from "electron";
import path from "node:path";

import { cleanAttachments } from "./attachments.ts";
import { CHANNELS } from "./channels.ts";
import { DEV_WEB_URL, IS_DEV, IS_SNAPSHOT, VERSION, resolveDataDir, serverCommand } from "./config.ts";
import { registerIpc } from "./ipc.ts";
import { initLog, log } from "./log.ts";
import { ServerSupervisor, type ServerReady } from "./server.ts";
import { readPlan, snapshotMain } from "./snapshot.ts";
import { createTray } from "./tray.ts";
import { initUpdater } from "./updater.ts";
import { VaultKeyError, loadDevKey, loadProtectedKey } from "./vault.ts";
import { createMainWindow, preloadPath, showWindow, statusPageUrl, windowIcon, zoomWindow } from "./window.ts";

const PRELOAD = preloadPath(__dirname);
const IS_MAC = process.platform === "darwin";
/** If the server isn't ready by then, the window opens with a short "starting" note. */
const SLOW_START_MS = 2500;

let win: BrowserWindow | null = null;
let tray: Electron.Tray | null = null;
let server: ServerSupervisor | null = null;
let serverStopped = false;
let quitting = false;
let closeToTray = true;
/** The app (not a status page) is what the window shows. */
let showingApp = false;
let failedLoads = 0;
/** The window has been on screen once (later reloads never pop it out of the tray). */
let everShown = false;

const windowAlive = () => (win && !win.isDestroyed() ? win : null);
const originOf = (url: string) => new URL(url).origin;

/** Where the UI may come from: Vite's origin in dev, and the running server's. */
function appOrigins(): string[] {
  const origins: string[] = [];
  if (IS_DEV) origins.push(originOf(DEV_WEB_URL));
  const ready = server?.ready;
  if (ready) origins.push(originOf(ready.url));
  return origins;
}

function fatal(title: string, message: string): never {
  log.error(`${title}: ${message}`);
  dialog.showErrorBox(title, message);
  app.exit(1);
  throw new Error(message);
}

// ── Permissions and menu ────────────────────────────────────────────────────────────────────

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "notifications"]);

function restrictPermissions(origins: () => string[]): void {
  const isApp = (url: string | undefined) => {
    try {
      return url ? origins().includes(new URL(url).origin) : false;
    } catch {
      return false;
    }
  };
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isApp(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isApp(requestingOrigin);
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/** A menu item the page carries out, with the window brought up first. */
function menuAction(action: "settings" | "check-for-updates"): void {
  openWindow();
  sendToWindow(CHANNELS.menuAction, action);
}

/**
 * Windows shows no menu bar; the menu only provides the shortcuts. Ctrl+R and Ctrl+W are left
 * to the app, so reloading is F5 in development only. macOS always has a menu bar: there it is
 * the usual app menu (About, Settings…, Hide, Quit), File, Edit, View and Window.
 */
function applicationMenu(): void {
  const zoom = (direction: "in" | "out" | "reset") => () => zoomWindow(windowAlive(), direction);
  const view: MenuItemConstructorOptions[] = [
    { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: zoom("in") },
    { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", visible: false, click: zoom("in") },
    { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: zoom("out") },
    { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: zoom("reset") },
    { type: "separator" },
    IS_MAC ? { role: "togglefullscreen" } : { role: "togglefullscreen", accelerator: "F11" },
    { role: "toggleDevTools", accelerator: IS_MAC ? "Alt+Command+I" : "Ctrl+Shift+I" },
  ];
  if (IS_DEV) view.push({ role: "reload", accelerator: "F5" }, { role: "forceReload", accelerator: "Shift+F5" });
  const edit: MenuItemConstructorOptions[] = [
    { role: "undo" },
    { role: "redo" },
    { type: "separator" },
    { role: "cut" },
    { role: "copy" },
    { role: "paste" },
    { role: "pasteAndMatchStyle" },
    { role: "selectAll" },
  ];
  if (IS_MAC) edit.push({ type: "separator" }, { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] });

  const template: MenuItemConstructorOptions[] = [];
  if (IS_MAC) {
    template.push(
      {
        label: "Fancy Mail",
        submenu: [
          { role: "about", label: "About Fancy Mail" },
          { label: "Check for Updates…", click: () => menuAction("check-for-updates") },
          { type: "separator" },
          { label: "Settings…", accelerator: "Command+,", click: () => menuAction("settings") },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: "Hide Fancy Mail" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: "Quit Fancy Mail" },
        ],
      },
      // Command+W closes the window (Fancy Mail keeps running); the app itself has no Command+W.
      { label: "File", submenu: [{ role: "close", label: "Close Window" }] },
    );
  }
  template.push({ label: "Edit", submenu: edit }, { label: "View", submenu: view });
  if (IS_MAC) template.push({ role: "windowMenu", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── The window and what it shows ────────────────────────────────────────────────────────────

function sendToWindow(channel: string, payload: unknown): void {
  const target = windowAlive();
  if (target && showingApp) target.webContents.send(channel, payload);
}

function showStatus(title: string, lines: string[]): void {
  const target = windowAlive();
  if (!target) return;
  showingApp = false;
  void target.loadURL(statusPageUrl(title, lines)).catch(() => {});
  if (!target.isVisible()) target.show();
}

/** The route the window shows now, to come back to it after a reload. */
function currentHash(): string {
  const target = windowAlive();
  if (!target || !showingApp) return "#/inbox";
  try {
    const hash = new URL(target.webContents.getURL()).hash;
    return hash && hash !== "#" && hash !== "#/" ? hash : "#/inbox";
  } catch {
    return "#/inbox";
  }
}

function loadApp(ready: ServerReady): void {
  const target = windowAlive();
  if (!target) return;
  const base = IS_DEV ? DEV_WEB_URL : ready.url;
  const hash = currentHash();
  showingApp = true;
  void target.loadURL(`${base}/?t=${encodeURIComponent(ready.sessionToken)}${hash}`).catch(() => {
    // did-fail-load handles it.
  });
}

function createWindow(): BrowserWindow {
  const created = createMainWindow({
    preload: PRELOAD,
    boundsFile: path.join(dataDir, "window.json"),
    appOrigins,
  });
  win = created;
  created.once("ready-to-show", () => showWindow(created));
  created.once("show", () => {
    everShown = true;
  });

  created.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !showingApp || quitting) return; // -3: aborted (a new load started)
    failedLoads++;
    log.warn(`the window could not load the app (${description}); trying again`);
    if (IS_DEV && url.startsWith(DEV_WEB_URL)) {
      showStatus("Waiting for the web app", [`Vite isn't answering on ${DEV_WEB_URL} yet. Start it with pnpm dev.`]);
    } else if (!everShown) {
      // The very first load failed: show the window (blank until the retry) rather than nothing.
      showWindow(created);
    }
    setTimeout(() => {
      const ready = server?.ready;
      if (ready && windowAlive()) loadApp(ready);
    }, Math.min(1000 * failedLoads, 5000));
  });
  created.webContents.on("did-finish-load", () => {
    if (showingApp) failedLoads = 0;
  });
  created.webContents.on("render-process-gone", (_event, details) => {
    if (quitting || details.reason === "clean-exit") return;
    log.error(`the window's page stopped (${details.reason}); reloading`);
    setTimeout(() => {
      const ready = server?.ready;
      if (ready && windowAlive()) loadApp(ready);
    }, 1000);
  });

  created.on("close", (event) => {
    if (quitting) return;
    // A Mac app keeps running when its window closes (the Dock brings it back); on Windows the
    // tray does that, unless it is turned off in Settings.
    if (!IS_MAC && (!closeToTray || !tray)) return;
    event.preventDefault();
    if (IS_MAC && created.isFullScreen()) {
      // Hiding a full-screen window leaves an empty Space behind: leave full screen first.
      created.once("leave-full-screen", () => created.hide());
      created.setFullScreen(false);
    } else {
      created.hide();
    }
  });
  created.on("closed", () => {
    win = null;
    showingApp = false;
  });
  return created;
}

function openWindow(): void {
  if (!windowAlive()) {
    createWindow();
    const ready = server?.ready;
    if (ready) loadApp(ready);
    return;
  }
  showWindow(win);
}

// ── Start and quit ──────────────────────────────────────────────────────────────────────────

let dataDir = "";

async function stopServer(): Promise<void> {
  if (!server || serverStopped) return;
  serverStopped = true;
  await server.stop();
}

function startApp(): void {
  initLog(path.join(dataDir, "logs"), IS_DEV);
  log.info(`Fancy Mail ${VERSION} starting (${IS_DEV ? "development" : "installed"}; data in ${dataDir})`);

  let vaultKey: Buffer;
  try {
    const result = IS_DEV ? loadDevKey(dataDir) : loadProtectedKey(dataDir);
    vaultKey = result.key;
    if (result.created) log.info("created a new vault key");
  } catch (error) {
    const message = error instanceof VaultKeyError ? error.message : `The vault key could not be read: ${String(error)}`;
    fatal("Fancy Mail can't start", message);
  }

  restrictPermissions(appOrigins);
  applicationMenu();
  registerIpc({
    window: windowAlive,
    server: () => server?.ready ?? null,
    appOrigins,
    dataDir,
    setCloseToTray: (on) => {
      closeToTray = on;
    },
    showWindow: openWindow,
    stopServerForUpdate: async () => {
      quitting = true;
      await stopServer();
    },
    notificationIcon: windowIcon,
  });

  createWindow();
  // macOS has the Dock instead (clicking it brings the window back: "activate").
  if (!IS_MAC) tray = createTray({ open: openWindow, quit: () => app.quit() });

  const { entry, args } = serverCommand(dataDir);
  server = new ServerSupervisor({
    entry,
    args,
    env: { FANCY_MAIL_VERSION: VERSION, NODE_NO_WARNINGS: "1" },
    vaultKey,
    logFile: path.join(dataDir, "logs", "desktop-server.log"),
    echo: IS_DEV,
    onReady: (ready) => loadApp(ready),
    onDown: (down) => {
      // While the app is on screen it shows "Reconnecting…" by itself; only a server that
      // never came up needs a page of its own.
      if (showingApp) return;
      showStatus("Fancy Mail's mail server isn't running", [
        down.reason,
        `Trying again in ${Math.round(down.retryInMs / 1000)} s.`,
        `Details: ${path.join(dataDir, "logs", "desktop-server.log")}`,
      ]);
    },
  });
  server.start();

  setTimeout(() => {
    const target = windowAlive();
    if (target && !showingApp && !target.isVisible() && !server?.ready) {
      showStatus("Starting Fancy Mail…", ["Opening your mail on this computer."]);
    }
  }, SLOW_START_MS);

  initUpdater(
    (state) => sendToWindow(CHANNELS.updateChanged, state),
    async () => {
      quitting = true;
      await stopServer();
    },
  );
  setTimeout(cleanAttachments, 30_000);
}

function main(): void {
  try {
    dataDir = resolveDataDir();
  } catch (error) {
    app.whenReady().then(() => fatal("Fancy Mail can't start", String(error instanceof Error ? error.message : error)));
    return;
  }

  if (IS_SNAPSHOT) {
    app.commandLine.appendSwitch("force-device-scale-factor", "1");
    app.whenReady().then(() => {
      const origin = (() => {
        try {
          return [originOf(readPlan().url)];
        } catch {
          return [];
        }
      })();
      restrictPermissions(() => origin);
      // The UI asks for the update state on load; snapshots have no updater.
      ipcMain.handle(CHANNELS.updateState, () => ({ state: "disabled" }));
      void snapshotMain((plan) =>
        createMainWindow({
          preload: PRELOAD,
          boundsFile: null,
          appOrigins: () => origin,
          snapshotSize: { width: plan.width || 1440, height: plan.height || 900 },
        }),
      );
    });
    return;
  }

  // One Fancy Mail at a time (per data folder: dev and the installed app don't collide).
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Windows groups the taskbar button and notifications by this id.
  if (process.platform === "win32") app.setAppUserModelId(IS_DEV ? process.execPath : "com.otakugamer.fancymail");
  app.on("second-instance", openWindow);
  app.whenReady().then(startApp);

  app.on("window-all-closed", () => {
    // With the tray, closing hides the window instead; this runs when close-to-tray is off.
    // A Mac app stays running with no window, until Quit.
    if (!IS_MAC) app.quit();
  });
  // macOS: the Dock icon was clicked (or the app opened again): bring the window back.
  app.on("activate", () => {
    if (!quitting) openWindow();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (!server || serverStopped) return;
    event.preventDefault();
    void stopServer().finally(() => app.quit());
  });
  // Ctrl+C in the `pnpm dev` terminal: quit the normal way, so the server stops cleanly.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  app.on("will-quit", () => {
    tray?.destroy();
    tray = null;
  });
}

main();
