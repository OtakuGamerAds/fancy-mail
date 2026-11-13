/**
 * The notification-area icon (Windows; a Mac has the Dock instead): click opens the window, the menu has Open and Quit.
 * Closing the window keeps Fancy Mail running here, so new mail still arrives.
 */
import { Menu, Tray, nativeImage } from "electron";

import tray16 from "../build/tray-16.png";
import tray20 from "../build/tray-20.png";
import tray24 from "../build/tray-24.png";
import tray32 from "../build/tray-32.png";
import tray40 from "../build/tray-40.png";
import tray48 from "../build/tray-48.png";

/** One image with a size for each display scale (100 %…300 %). */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  const sizes: [number, Uint8Array][] = [
    [1, tray16],
    [1.25, tray20],
    [1.5, tray24],
    [2, tray32],
    [2.5, tray40],
    [3, tray48],
  ];
  for (const [scaleFactor, bytes] of sizes) image.addRepresentation({ scaleFactor, buffer: Buffer.from(bytes) });
  return image;
}

export function createTray(actions: { open: () => void; quit: () => void }): Tray {
  const tray = new Tray(trayImage());
  tray.setToolTip("Fancy Mail");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Fancy Mail", click: actions.open },
      { type: "separator" },
      { label: "Quit", click: actions.quit },
    ]),
  );
  tray.on("click", actions.open);
  tray.on("double-click", actions.open);
  return tray;
}
