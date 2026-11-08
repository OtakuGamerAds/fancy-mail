/**
 * The desktop shell's bridge (apps/desktop preload). It is absent in a plain browser, so every
 * use here has a browser fallback: links open in a new tab, attachments through the server.
 */

/** The updater's state (apps/desktop updater). Fields beyond `status` may be missing. */
export interface UpdateState {
  status:
    | "disabled"
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "ready"
    | "downloaded"
    | "error";
  enabled?: boolean;
  /** The version that is available or downloaded. */
  version?: string | null;
  availableVersion?: string | null;
  downloadedVersion?: string | null;
  currentVersion?: string | null;
  /** 0–100 while downloading. */
  percent?: number | null;
  downloadPercent?: number | null;
  message?: string | null;
}

export interface FancyMailBridge {
  platform: string;
  version: string;
  openExternal(url: string): void;
  openAttachment(url: string, filename: string): void;
  showItemInFolder(path: string): void;
  openPath(path: string): void;
  setCloseToTray(on: boolean): void;
  notify(n: { title: string; body: string; threadId?: string }): void;
  onOpenThread(cb: (threadId: string) => void): (() => void) | void;
  update?: {
    state(): Promise<UpdateState>;
    check(): Promise<unknown> | void;
    download(): Promise<unknown> | void;
    install(): Promise<unknown> | void;
    onState(cb: (state: UpdateState) => void): (() => void) | void;
  };
}

declare global {
  interface Window {
    fancyMail?: FancyMailBridge;
  }
}

export function bridge(): FancyMailBridge | undefined {
  return typeof window === "undefined" ? undefined : window.fancyMail;
}

export const isDesktop = (): boolean => bridge() !== undefined;

export function isWindowsDesktop(): boolean {
  return /^win/i.test(bridge()?.platform ?? "");
}

/** Opens a web or mailto link outside the app: the default browser, or a new tab. */
export function openExternal(url: string): void {
  const desktop = bridge();
  if (desktop) {
    desktop.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function attachmentUrl(attachmentId: string, download = false): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}${download ? "?download=1" : ""}`;
}

export function openAttachment(attachmentId: string, filename: string): void {
  const desktop = bridge();
  const url = attachmentUrl(attachmentId);
  if (desktop) {
    desktop.openAttachment(new URL(url, window.location.href).href, filename);
    return;
  }
  window.open(url, "_blank", "noopener");
}

export function downloadAttachment(attachmentId: string, filename: string): void {
  const link = document.createElement("a");
  link.href = attachmentUrl(attachmentId, true);
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

/** Normalized update info, whichever field names the shell uses. */
export function describeUpdate(state: UpdateState | null): {
  visible: boolean;
  phase: "available" | "downloading" | "ready" | "other";
  version: string | null;
  percent: number | null;
  message: string | null;
} {
  if (!state) return { visible: false, phase: "other", version: null, percent: null, message: null };
  const version = state.version ?? state.downloadedVersion ?? state.availableVersion ?? null;
  const percent = state.percent ?? state.downloadPercent ?? null;
  const phase =
    state.status === "available"
      ? "available"
      : state.status === "downloading"
        ? "downloading"
        : state.status === "ready" || state.status === "downloaded"
          ? "ready"
          : "other";
  return { visible: phase !== "other", phase, version, percent, message: state.message ?? null };
}
