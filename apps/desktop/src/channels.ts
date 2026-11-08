/** IPC channel names shared by the main process and the preload. */
export const CHANNELS = {
  openExternal: "fm:open-external",
  openAttachment: "fm:open-attachment",
  showItemInFolder: "fm:show-item-in-folder",
  openPath: "fm:open-path",
  setCloseToTray: "fm:set-close-to-tray",
  notify: "fm:notify",
  openThread: "fm:open-thread",
  updateState: "fm:update-state",
  updateCheck: "fm:update-check",
  updateDownload: "fm:update-download",
  updateInstall: "fm:update-install",
  updateChanged: "fm:update-changed",
} as const;
