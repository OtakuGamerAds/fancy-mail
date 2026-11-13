/**
 * `window.fancyMail`: the few things the web app asks of the desktop shell. Runs sandboxed;
 * the main process checks every argument again (apps/desktop/src/ipc.ts).
 */
import { contextBridge, ipcRenderer, webFrame } from "electron";

import { CHANNELS } from "./channels.ts";

type Unsubscribe = () => void;

function listen<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  if (typeof callback !== "function") return () => {};
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

// macOS: the page keeps clear of the traffic lights (top left) with --desktop-window-controls-inset,
// as T3 Code's preload does. The buttons ignore the page's zoom, so the inset shrinks as the page
// zooms in; in full screen they are hidden and the inset is 0.
if (process.platform === "darwin") {
  let fullscreen = false;
  const syncInset = () => {
    const inset = fullscreen ? 0 : 90 / webFrame.getZoomFactor();
    document.documentElement.style.setProperty("--desktop-window-controls-inset", `${inset}px`);
  };
  window.addEventListener("DOMContentLoaded", syncInset, { once: true });
  window.addEventListener("resize", syncInset);
  ipcRenderer.on(CHANNELS.fullscreenChanged, (_event, value: unknown) => {
    fullscreen = value === true;
    syncInset();
  });
}

contextBridge.exposeInMainWorld("fancyMail", {
  platform: process.platform,
  version: __FANCY_MAIL_VERSION__,
  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  /** Resolves to `{ ok, path?, shownInFolder? }` or `{ ok: false, message }`. */
  openAttachment: (url: string, filename: string) => ipcRenderer.invoke(CHANNELS.openAttachment, url, filename),
  showItemInFolder: (path: string) => ipcRenderer.invoke(CHANNELS.showItemInFolder, path),
  /** Resolves to "" when opened, or an error message. */
  openPath: (path: string) => ipcRenderer.invoke(CHANNELS.openPath, path),
  setCloseToTray: (on: boolean) => ipcRenderer.send(CHANNELS.setCloseToTray, on),
  notify: (n: { title: string; body: string; threadId?: string }) => ipcRenderer.send(CHANNELS.notify, n),
  onOpenThread: (callback: (threadId: string) => void) => listen(CHANNELS.openThread, callback),
  /** A menu item for the page to carry out ("settings"). */
  onMenuAction: (callback: (action: string) => void) => listen(CHANNELS.menuAction, callback),
  update: {
    state: () => ipcRenderer.invoke(CHANNELS.updateState),
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(CHANNELS.updateDownload),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    onState: (callback: (state: unknown) => void) => listen(CHANNELS.updateChanged, callback),
  },
});
