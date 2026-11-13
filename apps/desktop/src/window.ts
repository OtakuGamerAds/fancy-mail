/**
 * The main window: its size and place (remembered in <dataDir>/window.json), what it may
 * navigate to, and the small native context menu for text.
 */
import { BrowserWindow, Menu, app, clipboard, nativeImage, screen, shell, type Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";

import appIcon from "../build/icon-256.png";
import { CHANNELS } from "./channels.ts";
import { log } from "./log.ts";

const DEFAULT_WIDTH = 1320;
const DEFAULT_HEIGHT = 840;

interface SavedBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const windowIcon = () => nativeImage.createFromBuffer(Buffer.from(appIcon));

// ── Title bar ───────────────────────────────────────────────────────────────────────────────
//
// After T3 Code's apps/desktop/src/window/DesktopWindow.ts (MIT License — see
// THIRD_PARTY_LICENSE_T3CODE.txt). The page draws its own title bar in every case:
// - Windows: the native buttons are drawn over the top right (titleBarOverlay); the page keeps
//   clear of them with --wco-inset (apps/web/src/lib/windowControls.ts).
// - macOS: the traffic lights sit in the top left, centered on the page's 52 px header; the
//   page keeps clear of them with --desktop-window-controls-inset (set by the preload).

/** The page's header strip (apps/web --header-height). */
const HEADER_HEIGHT = 52;
const MAC_WINDOW_BUTTON_RADIUS = 7;

type TitleBarOptions = Pick<Electron.BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition">;

export function titleBarOptions(platform: NodeJS.Platform): TitleBarOptions {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: HEADER_HEIGHT / 2 - MAC_WINDOW_BUTTON_RADIUS } };
  }
  return { titleBarStyle: "hidden", titleBarOverlay: { color: "#00000000", symbolColor: "#d4d4d4", height: 40 } };
}

/** macOS: the native buttons ignore the page's zoom, so they move with it to stay centered on the header. */
export function syncMacWindowButtons(win: BrowserWindow): void {
  if (process.platform !== "darwin" || win.isDestroyed() || win.isFullScreen()) return;
  win.setWindowButtonPosition({
    x: 16,
    y: Math.round((HEADER_HEIGHT * win.webContents.getZoomFactor()) / 2 - MAC_WINDOW_BUTTON_RADIUS),
  });
}

// ── Bounds ──────────────────────────────────────────────────────────────────────────────────

function readBounds(file: string): SavedBounds | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SavedBounds>;
    if (typeof value.width !== "number" || typeof value.height !== "number") return null;
    const bounds: SavedBounds = {
      width: Math.max(900, Math.round(value.width)),
      height: Math.max(560, Math.round(value.height)),
      maximized: value.maximized === true,
    };
    if (typeof value.x === "number" && typeof value.y === "number") {
      // Only where a display still is (a monitor may have been unplugged since).
      const rect: Rectangle = { x: Math.round(value.x), y: Math.round(value.y), width: bounds.width, height: bounds.height };
      const area = screen.getDisplayMatching(rect).workArea;
      const visibleX = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
      const visibleY = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
      if (visibleX >= 120 && visibleY >= 80) {
        bounds.x = rect.x;
        bounds.y = rect.y;
        bounds.width = Math.min(bounds.width, area.width);
        bounds.height = Math.min(bounds.height, area.height);
      }
    }
    return bounds;
  } catch {
    return null;
  }
}

function rememberBounds(win: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    timer = null;
    if (win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized() || win.isFullScreen();
    // While maximized, keep the size it returns to.
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    const data: SavedBounds = { ...bounds, maximized };
    try {
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (error) {
      log.warn("could not save the window's place", error);
    }
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"] as const) win.on(event as "resize", later);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

// ── Navigation safety ───────────────────────────────────────────────────────────────────────

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function openExternally(url: string): void {
  if (!isExternalUrl(url)) {
    log.warn("refused to open a link that is not http(s) or mailto");
    return;
  }
  shell.openExternal(url).catch((error: unknown) => log.warn("could not open a link", error));
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The window shows the app and nothing else. New windows (target=_blank, window.open) open
 * in the browser; navigating the page away from the app opens the link there instead; a link
 * clicked inside an email (a sandboxed frame) does the same.
 */
function guardNavigation(win: BrowserWindow, appOrigins: () => string[]): void {
  const contents = win.webContents;
  const isApp = (url: string) => {
    const origin = originOf(url);
    return origin !== null && appOrigins().includes(origin);
  };

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url) && !isApp(url)) openExternally(url);
    else if (isApp(url)) log.warn("refused to open the app in a second window");
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isApp(url)) return;
    event.preventDefault();
    if (isExternalUrl(url)) openExternally(url);
  });
  contents.on("will-redirect", (event, url) => {
    if (isApp(url)) return;
    event.preventDefault();
  });

  // Links inside an email's frame: open them in the browser, never inside the frame.
  contents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    const { url } = details;
    if (url.startsWith("about:") || url.startsWith("data:") || url.startsWith("blob:") || isApp(url)) return;
    details.preventDefault();
    if (isExternalUrl(url)) openExternally(url);
  });

  contents.on("will-attach-webview", (event) => event.preventDefault());
}

// ── Context menu for text ───────────────────────────────────────────────────────────────────

/**
 * Cut, copy, paste and spelling suggestions in text fields; Copy for selected text; Copy link.
 * The app's own menus (on conversations, labels…) prevent the browser's menu, so this only
 * shows where the page did not handle the right click itself.
 */
function textContextMenu(win: BrowserWindow): void {
  const contents = win.webContents;
  contents.on("context-menu", (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length === 0) template.push({ label: "No suggestions", enabled: false });
      template.push({
        label: "Add to dictionary",
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: "separator" });
    }
    if (params.isEditable) {
      const { editFlags } = params;
      template.push(
        { label: "Undo", role: "undo", enabled: editFlags.canUndo },
        { label: "Redo", role: "redo", enabled: editFlags.canRedo },
        { type: "separator" },
        { label: "Cut", role: "cut", enabled: editFlags.canCut },
        { label: "Copy", role: "copy", enabled: editFlags.canCopy },
        { label: "Paste", role: "paste", enabled: editFlags.canPaste },
        { label: "Paste as plain text", role: "pasteAndMatchStyle", enabled: editFlags.canPaste },
        { type: "separator" },
        { label: "Select all", role: "selectAll", enabled: editFlags.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      template.push({ label: "Copy", role: "copy" });
    }
    if (params.linkURL && isExternalUrl(params.linkURL)) {
      if (template.length) template.push({ type: "separator" });
      const isMail = params.linkURL.startsWith("mailto:");
      template.push({
        label: isMail ? "Copy email address" : "Copy link",
        click: () => clipboard.writeText(isMail ? decodeURIComponent(params.linkURL.slice(7).split("?")[0] ?? "") : params.linkURL),
      });
      if (!isMail) template.push({ label: "Open link in browser", click: () => openExternally(params.linkURL) });
    }
    while (template.at(-1)?.type === "separator") template.pop();
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

// ── Window ──────────────────────────────────────────────────────────────────────────────────

export interface MainWindowOptions {
  preload: string;
  boundsFile: string | null;
  appOrigins: () => string[];
  /** Snapshot runs: an exact size, never shown on screen. */
  snapshotSize?: { width: number; height: number };
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const saved = options.boundsFile ? readBounds(options.boundsFile) : null;
  const size = options.snapshotSize ?? { width: saved?.width ?? DEFAULT_WIDTH, height: saved?.height ?? DEFAULT_HEIGHT };
  const win = new BrowserWindow({
    ...size,
    ...(saved?.x !== undefined && saved.y !== undefined && !options.snapshotSize ? { x: saved.x, y: saved.y } : {}),
    useContentSize: Boolean(options.snapshotSize),
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: "Fancy Mail",
    backgroundColor: "#000000",
    ...titleBarOptions(process.platform),
    // macOS takes the icon from the app bundle (and the Dock); a window icon is for Windows and Linux.
    ...(process.platform === "darwin" ? {} : { icon: windowIcon() }),
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: !options.snapshotSize,
    },
  });
  win.setMenuBarVisibility(false);
  if (saved?.maximized && !options.snapshotSize) win.maximize();
  if (options.boundsFile && !options.snapshotSize) rememberBounds(win, options.boundsFile);
  guardNavigation(win, options.appOrigins);
  textContextMenu(win);
  if (process.platform === "darwin") {
    win.webContents.on("did-finish-load", () => syncMacWindowButtons(win));
    win.on("enter-full-screen", () => win.webContents.send(CHANNELS.fullscreenChanged, true));
    win.on("leave-full-screen", () => {
      syncMacWindowButtons(win);
      win.webContents.send(CHANNELS.fullscreenChanged, false);
    });
  }
  return win;
}

/** Zoom in, out or back to 100 % (the View menu), keeping macOS's window buttons in place. */
export function zoomWindow(win: BrowserWindow | null, direction: "in" | "out" | "reset"): void {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  contents.setZoomLevel(direction === "reset" ? 0 : contents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5));
  syncMacWindowButtons(win);
}

export function showWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  // macOS brings the window forward only when the app itself is active (a notification click, a second launch).
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
}

// ── Status page (shown only while the server cannot start) ──────────────────────────────────

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** A plain page in the app's colors; the window keeps it until the server is back. */
export function statusPageUrl(title: string, lines: string[]): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Fancy Mail</title>
<style>
  html,body{margin:0;height:100%;background:#000;color:#d4d4d4;font:14px/1.5 -apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
  .drag{position:fixed;inset:0 0 auto 0;height:40px;-webkit-app-region:drag}
  main{height:100%;display:grid;place-content:center;padding:0 32px;max-width:560px;margin:0 auto}
  h1{font-size:15px;font-weight:600;color:#fafafa;margin:0 0 6px}
  p{margin:0 0 4px;color:#a1a1aa;overflow-wrap:anywhere}
  code{font:12px ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace;color:#a1a1aa}
</style></head><body><div class="drag"></div><main>
<h1>${escapeHtml(title)}</h1>
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")}
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export const preloadPath = (dir: string) => path.join(dir, "preload.cjs");
