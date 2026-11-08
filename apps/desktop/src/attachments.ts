/**
 * Opening an attachment with the program Windows has for it: the file is downloaded from the
 * local server to <temp>/Fancy Mail/<name> and opened from there. Programs and scripts are
 * never run straight from an email; their folder is shown instead.
 */
import { shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Files that run code when opened. */
const RUNNABLE = new Set(
  (
    "exe com scr pif bat cmd msi msp msc cpl dll ps1 psm1 psd1 vbs vbe js jse wsf wsh hta lnk reg inf " +
    "jar app appx appxbundle msix msixbundle application gadget scf url iso img vhd vhdx xll ws sct chm " +
    "py pyw rb pl sh library-ms settingcontent-ms appref-ms diagcab"
  ).split(" "),
);

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** A file name that is safe on Windows and cannot leave the folder. */
export function safeFileName(name: string): string {
  let clean = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\|?*\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!clean || RESERVED.test(clean)) clean = `attachment${clean ? `-${clean}` : ""}`;
  if (clean.length > 150) {
    const ext = path.extname(clean).slice(0, 20);
    clean = clean.slice(0, 150 - ext.length) + ext;
  }
  return clean;
}

export const attachmentsDir = () => path.join(os.tmpdir(), "Fancy Mail");

/** A path that does not exist yet: "name.pdf", "name (2).pdf", … (an open file stays locked). */
function freePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

export type OpenResult = { ok: true; path: string; shownInFolder?: boolean } | { ok: false; message: string };

/**
 * `serverUrl` is where the bytes come from (the window's URL may be Vite's in dev);
 * `sessionToken` authenticates like the window's cookie does.
 */
export async function openAttachment(
  pathAndQuery: string,
  filename: string,
  server: { url: string; sessionToken: string },
): Promise<OpenResult> {
  const dir = attachmentsDir();
  fs.mkdirSync(dir, { recursive: true });
  let response: Response;
  try {
    response = await fetch(`${server.url}${pathAndQuery}`, {
      headers: { "x-fancy-mail-session": server.sessionToken },
      redirect: "error",
    });
  } catch {
    return { ok: false, message: "Couldn't reach Fancy Mail's server. Try again in a moment." };
  }
  if (!response.ok || !response.body) {
    return {
      ok: false,
      message:
        response.status === 404
          ? "This attachment isn't on this computer yet. Open the conversation to download it, then try again."
          : `Couldn't get the attachment (error ${response.status}).`,
    };
  }
  const target = freePath(dir, safeFileName(filename));
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), fs.createWriteStream(target));
  } catch {
    fs.rmSync(target, { force: true });
    return { ok: false, message: "Couldn't save the attachment to the temp folder. Check the free space on your drive." };
  }
  const ext = path.extname(target).slice(1).toLowerCase();
  if (RUNNABLE.has(ext)) {
    shell.showItemInFolder(target);
    return { ok: true, path: target, shownInFolder: true };
  }
  const error = await shell.openPath(target);
  if (error) {
    shell.showItemInFolder(target);
    return { ok: true, path: target, shownInFolder: true };
  }
  return { ok: true, path: target };
}

/** Removes attachments opened more than a day ago (they are copies; the mail keeps its own). */
export function cleanAttachments(): void {
  const dir = attachmentsDir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true, recursive: true });
    } catch {
      // Still open in another program: try again next time.
    }
  }
}
