/**
 * The native window controls (min/max/close) drawn over the top right on Windows
 * (`titleBarOverlay`). `--wco-inset` is how far from the right edge controls must stay, and
 * `--wco-height` how tall that area is; both are 0 in a browser.
 */
import { useSyncExternalStore } from "react";

import { isWindowsDesktop } from "./desktop";

interface WindowControlsOverlay extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

function overlay(): WindowControlsOverlay | null {
  const nav = navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay };
  return nav.windowControlsOverlay ?? null;
}

interface Geometry {
  inset: number;
  height: number;
}

let geometry: Geometry = { inset: 0, height: 0 };
const listeners = new Set<() => void>();

function measure(): Geometry {
  const wco = overlay();
  if (wco?.visible) {
    const rect = wco.getTitlebarAreaRect();
    const inset = Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width)));
    return { inset: inset > 0 ? inset : 138, height: Math.round(rect.height) || 40 };
  }
  // The shell asks for a 40 px overlay on Windows; keep clear of it even if the API is missing.
  if (isWindowsDesktop()) return { inset: 138, height: 40 };
  return { inset: 0, height: 0 };
}

function apply() {
  const next = measure();
  if (next.inset === geometry.inset && next.height === geometry.height) return;
  geometry = next;
  const root = document.documentElement;
  root.style.setProperty("--wco-inset", `${next.inset}px`);
  root.style.setProperty("--wco-height", `${next.height}px`);
  root.classList.toggle("wco", next.inset > 0);
  for (const listener of listeners) listener();
}

/** Starts tracking the controls' geometry; call once at startup. */
export function initWindowControls(): void {
  geometry = { inset: -1, height: -1 };
  apply();
  overlay()?.addEventListener("geometrychange", apply);
  window.addEventListener("resize", apply);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The height of the native title bar area (0 in a browser). */
export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.max(0, geometry.height),
    () => 0,
  );
}
