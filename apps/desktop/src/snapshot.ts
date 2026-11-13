/**
 * Snapshot mode (FANCY_MAIL_SNAPSHOT=1, run by scripts/snapshot.mjs): renders each route of a
 * plan to a PNG and quits. The script starts the server; this only drives a window.
 *
 * Plan (JSON file named by FANCY_MAIL_SNAPSHOT_PLAN):
 *   { url, token, outDir, width, height, routes: [{ name, hash, click? }] }
 * Each route is loaded fresh, then the page is given time to settle: no requests in flight
 * and no DOM changes for half a second (at most 15 s), plus 600 ms. `click` is a step, or a
 * list of steps run in order (the page settles after each), before the capture:
 *   "selector"         click it (e.g. "[data-thread-row]" opens the first conversation)
 *   "right:selector"   right-click it (its context menu)
 *   "swipe:selector"   drag it to the left with the pointer, past the swipe threshold
 *   "text:words"       click the menu item, button or link whose text starts with the words
 * Errors in the page are printed with the route's name.
 */
import { app, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

import { log } from "./log.ts";

export interface Plan {
  url: string;
  token: string;
  outDir: string;
  width: number;
  height: number;
  routes: { name: string; hash: string; click?: string | string[] }[];
}

const QUIET_MS = 500;
const SETTLE_MAX_MS = 15_000;
const EXTRA_MS = 600;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function readPlan(): Plan {
  const file = process.env.FANCY_MAIL_SNAPSHOT_PLAN;
  if (!file) throw new Error("FANCY_MAIL_SNAPSHOT_PLAN is not set (run `pnpm snapshot`).");
  const plan = JSON.parse(fs.readFileSync(file, "utf8")) as Plan;
  if (!plan.url || !plan.token || !Array.isArray(plan.routes)) throw new Error(`${file} is not a snapshot plan.`);
  return plan;
}

/** Counts requests in flight on the window's session (HTTP only; the WebSocket stays open). */
function trackRequests(win: BrowserWindow): () => number {
  let inflight = 0;
  const ids = new Set<number>();
  const { webRequest } = win.webContents.session;
  webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) {
      ids.add(details.id);
      inflight = ids.size;
    }
    callback({});
  });
  const done = (details: { id: number }) => {
    ids.delete(details.id);
    inflight = ids.size;
  };
  webRequest.onCompleted(done);
  webRequest.onErrorOccurred(done);
  return () => inflight;
}

const DOM_QUIET = (quietMs: number, maxMs: number) => `new Promise((resolve) => {
  const deadline = Date.now() + ${maxMs};
  let last = Date.now();
  const observer = new MutationObserver(() => { last = Date.now(); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const tick = () => {
    if (Date.now() - last >= ${quietMs} || Date.now() > deadline) {
      observer.disconnect();
      resolve(Date.now() > deadline ? "timeout" : "quiet");
    } else setTimeout(tick, 50);
  };
  document.fonts.ready.then(() => setTimeout(tick, 50));
})`;

async function settle(win: BrowserWindow, inflight: () => number): Promise<string> {
  const started = Date.now();
  let result = "quiet";
  for (;;) {
    const remaining = SETTLE_MAX_MS - (Date.now() - started);
    if (remaining <= 0) {
      result = "timeout";
      break;
    }
    const dom = (await win.webContents.executeJavaScript(DOM_QUIET(QUIET_MS, remaining))) as string;
    if (dom === "timeout") {
      result = "timeout";
      break;
    }
    if (inflight() === 0) break;
    await sleep(100);
  }
  await sleep(EXTRA_MS);
  return result;
}

const NO_MOTION = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }";

/** One step, run in the page (plain script text: the bundle's helpers don't exist there). */
const STEP_SCRIPT = `(async (step) => {
  // A selector, or text:<words> for the first item, button, link or sidebar row starting with them.
  const find = (selector) => {
    if (!selector.startsWith("text:")) return document.querySelector(selector);
    const words = selector.slice(5).trim().toLowerCase();
    const candidates = Array.from(document.querySelectorAll("[role=menuitem], button, a, [role=option], [role=link]"));
    return candidates.find((c) => (c.textContent || "").trim().toLowerCase().startsWith(words)) || null;
  };
  if (step.startsWith("key:")) {
    // key:mod+b — "mod" is Command on a Mac and Ctrl elsewhere, as the app reads it.
    const parts = step.slice(4).split("+");
    const key = parts.pop();
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    const mac = /mac/i.test(navigator.platform);
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", {
      key, bubbles: true, cancelable: true,
      ctrlKey: mods.has("ctrl") || (mods.has("mod") && !mac),
      metaKey: mods.has("meta") || (mods.has("mod") && mac),
      shiftKey: mods.has("shift"), altKey: mods.has("alt"),
    }));
    return true;
  }
  if (step.startsWith("modclick:")) {
    // Ctrl+click, or Command+click on a Mac.
    const el = find(step.slice(9));
    if (!el) return false;
    const mac = /mac/i.test(navigator.platform);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: !mac, metaKey: mac }));
    return true;
  }
  if (step.startsWith("text:")) {
    const el = find(step);
    if (!el) return false;
    el.click();
    return true;
  }
  if (step.startsWith("right:")) {
    const el = find(step.slice(6));
    if (!el) return false;
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.top + box.height / 2, button: 2 }));
    return true;
  }
  if (step.startsWith("swipe:")) {
    const el = find(step.slice(6));
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const fire = (type, x) =>
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
    const start = box.left + box.width * 0.8;
    fire("pointerdown", start);
    for (let i = 1; i <= 12; i++) {
      fire("pointermove", start - (box.width * 0.6 * i) / 12);
      await new Promise((r) => setTimeout(r, 16));
    }
    fire("pointerup", start - box.width * 0.6);
    return true;
  }
  const el = find(step);
  if (!el) return false;
  el.click();
  return true;
})`;

async function load(win: BrowserWindow, url: string): Promise<void> {
  try {
    await win.loadURL(url);
  } catch (error) {
    // A hash-only change or a server redirect can reject although the page is there.
    if (!String(error).includes("ERR_ABORTED")) throw error;
  }
}

export async function runSnapshots(win: BrowserWindow, plan: Plan): Promise<number> {
  fs.mkdirSync(plan.outDir, { recursive: true });
  const inflight = trackRequests(win);
  let failures = 0;
  // Errors in the page (a crash leaves a blank window): printed with the route they happened in.
  let current = "start";
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(`[snapshot] ${current}: console error: ${details.message}`);
  });

  // The token becomes the session cookie (the server redirects to the same URL without it).
  await load(win, `${plan.url}/?t=${encodeURIComponent(plan.token)}#/inbox`);
  await settle(win, inflight);

  for (const [index, route] of plan.routes.entries()) {
    const started = Date.now();
    current = route.name;
    try {
      // A fresh document per route, so no overlay or selection carries over.
      await load(win, `${plan.url}/?snapshot=${index}${route.hash}`);
      // An off-screen window never advances animations, so things that fade or slide in would
      // stay at their first frame: show every view as it ends up.
      await win.webContents.insertCSS(NO_MOTION);
      let state = await settle(win, inflight);
      for (const step of route.click === undefined ? [] : Array.isArray(route.click) ? route.click : [route.click]) {
        const done = (await win.webContents.executeJavaScript(`${STEP_SCRIPT}(${JSON.stringify(step)})`)) as boolean;
        if (!done) log.warn(`[snapshot] ${route.name}: nothing matches ${step}`);
        state = await settle(win, inflight);
      }
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) throw new Error("the captured image is empty");
      const file = path.join(plan.outDir, `${route.name}.png`);
      fs.writeFileSync(file, image.toPNG());
      const { width, height } = image.getSize();
      console.log(`[snapshot] ${route.name}.png ${width}×${height} in ${Date.now() - started} ms${state === "timeout" ? " (still changing after 15 s)" : ""}`);
    } catch (error) {
      failures++;
      console.error(`[snapshot] ${route.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

export async function snapshotMain(createWindow: (plan: Plan) => BrowserWindow): Promise<void> {
  let code = 0;
  try {
    const plan = readPlan();
    const win = createWindow(plan);
    const failures = await runSnapshots(win, plan);
    code = failures ? 1 : 0;
    win.destroy();
  } catch (error) {
    console.error(`[snapshot] ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
  }
  app.exit(code);
}
