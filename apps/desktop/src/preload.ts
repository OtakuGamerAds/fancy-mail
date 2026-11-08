/**
 * `window.fancyMail`: the few things the web app asks of the desktop shell. Runs sandboxed;
 * the main process checks every argument again (apps/desktop/src/ipc.ts).
 */
import { contextBridge, ipcRenderer } from "electron";

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
  update: {
    state: () => ipcRenderer.invoke(CHANNELS.updateState),
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(CHANNELS.updateDownload),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    onState: (callback: (state: unknown) => void) => listen(CHANNELS.updateChanged, callback),
  },
});
