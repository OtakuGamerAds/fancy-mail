/**
 * What the window may ask of the shell (the preload's `window.fancyMail`). Every argument is
 * checked here: the page shows email from strangers, so nothing it sends is trusted blindly,
 * and only the app's own top frame may call at all.
 */
import { BrowserWindow, Notification, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import path from "node:path";

import { attachmentsDir, openAttachment, type OpenResult } from "./attachments.ts";
import { CHANNELS } from "./channels.ts";
import { log } from "./log.ts";
import type { ServerReady } from "./server.ts";
import { checkForUpdate, downloadUpdate, getUpdateState, installUpdate } from "./updater.ts";
import { openExternally, isExternalUrl } from "./window.ts";

export interface IpcContext {
  window: () => BrowserWindow | null;
  server: () => ServerReady | null;
  /** Origins the app is served from (Vite's in dev, the server's). */
  appOrigins: () => string[];
  dataDir: string;
  setCloseToTray: (on: boolean) => void;
  showWindow: () => void;
  stopServerForUpdate: () => Promise<void>;
  notificationIcon: () => Electron.NativeImage;
}

const isString = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function registerIpc(ctx: IpcContext): void {
  /** Only the main window's own page (not an email's frame, not another site). */
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = ctx.window();
    const frame = event.senderFrame;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !frame || frame.parent !== null) return false;
    try {
      return ctx.appOrigins().includes(new URL(frame.url).origin);
    } catch {
      return false;
    }
  };
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) {
        log.warn(`ignored ${channel} from an untrusted frame`);
        return null;
      }
      return fn(...args);
    });
  const on = (channel: string, fn: (...args: unknown[]) => void) =>
    ipcMain.on(channel, (event, ...args) => {
      if (!trusted(event)) {
        log.warn(`ignored ${channel} from an untrusted frame`);
        return;
      }
      fn(...args);
    });

  handle(CHANNELS.openExternal, (url) => {
    if (!isString(url, 8192) || !isExternalUrl(url)) return false;
    openExternally(url);
    return true;
  });

  handle(CHANNELS.openAttachment, async (url, filename): Promise<OpenResult> => {
    const server = ctx.server();
    if (!isString(url, 8192) || !isString(filename, 1024)) return { ok: false, message: "That attachment link isn't valid." };
    if (!server) return { ok: false, message: "Fancy Mail's server is starting. Try again in a moment." };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: "That attachment link isn't valid." };
    }
    const origins = [...ctx.appOrigins(), new URL(server.url).origin];
    if (!origins.includes(parsed.origin) || !parsed.pathname.startsWith("/api/")) {
      log.warn("refused to open an attachment from outside the app");
      return { ok: false, message: "That attachment link isn't from Fancy Mail." };
    }
    const result = await openAttachment(`${parsed.pathname}${parsed.search}`, filename, server);
    if (!result.ok) log.warn("could not open an attachment:", result.message);
    return result;
  });

  handle(CHANNELS.showItemInFolder, (target) => {
    if (!isString(target) || !path.isAbsolute(target)) return false;
    shell.showItemInFolder(path.normalize(target));
    return true;
  });

  // Only Fancy Mail's own folders: the data folder and the opened-attachments folder.
  handle(CHANNELS.openPath, async (target) => {
    if (!isString(target) || !path.isAbsolute(target)) return "Not a folder Fancy Mail can open.";
    if (!isInside(target, ctx.dataDir) && !isInside(target, attachmentsDir())) {
      log.warn("refused to open a path outside Fancy Mail's folders");
      return "Not a folder Fancy Mail can open.";
    }
    return shell.openPath(path.normalize(target));
  });

  on(CHANNELS.setCloseToTray, (value) => {
    if (typeof value === "boolean") ctx.setCloseToTray(value);
  });

  // Kept referenced until clicked or closed: Windows drops click handlers of collected ones.
  const shown = new Set<Notification>();
  on(CHANNELS.notify, (input) => {
    if (!Notification.isSupported() || typeof input !== "object" || input === null) return;
    const { title, body, threadId } = input as Record<string, unknown>;
    if (!isString(title, 500)) return;
    const notification = new Notification({
      title: title.slice(0, 120),
      body: typeof body === "string" ? body.slice(0, 300) : "",
      icon: ctx.notificationIcon(),
      silent: false,
    });
    const id = isString(threadId, 200) ? threadId : null;
    const forget = () => shown.delete(notification);
    notification.on("click", () => {
      forget();
      ctx.showWindow();
      if (id) ctx.window()?.webContents.send(CHANNELS.openThread, id);
    });
    notification.on("close", forget);
    notification.on("failed", forget);
    shown.add(notification);
    if (shown.size > 20) shown.delete(shown.values().next().value as Notification);
    notification.show();
  });

  handle(CHANNELS.updateState, () => getUpdateState());
  handle(CHANNELS.updateCheck, () => checkForUpdate());
  handle(CHANNELS.updateDownload, () => downloadUpdate());
  handle(CHANNELS.updateInstall, () => installUpdate(ctx.stopServerForUpdate));
}
