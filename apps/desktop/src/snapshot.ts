/**
 * Snapshot mode (FANCY_MAIL_SNAPSHOT=1, run by scripts/snapshot.mjs): renders each route of a
 * plan to a PNG and quits. The script starts the server; this only drives a window.
 *
 * Plan (JSON file named by FANCY_MAIL_SNAPSHOT_PLAN):
 *   { url, token, outDir, width, height, routes: [{ name, hash, click? }] }
 * Each route is loaded fresh, then the page is given time to settle: no requests in flight
 * and no DOM changes for half a second (at most 15 s), plus 600 ms. `click` is a CSS selector
 * clicked before the capture (e.g. "[data-thread-row]" to open the first conversation).
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
  routes: { name: string; hash: string; click?: string }[];
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

  // The token becomes the session cookie (the server redirects to the same URL without it).
  await load(win, `${plan.url}/?t=${encodeURIComponent(plan.token)}#/inbox`);
  await settle(win, inflight);

  for (const [index, route] of plan.routes.entries()) {
    const started = Date.now();
    try {
      // A fresh document per route, so no overlay or selection carries over.
      await load(win, `${plan.url}/?snapshot=${index}${route.hash}`);
      // An off-screen window never advances animations, so things that fade or slide in would
      // stay at their first frame: show every view as it ends up.
      await win.webContents.insertCSS(NO_MOTION);
      let state = await settle(win, inflight);
      if (route.click) {
        const clicked = (await win.webContents.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(route.click)}); if (!el) return false; el.click(); return true; })()`,
        )) as boolean;
        if (!clicked) log.warn(`[snapshot] ${route.name}: nothing matches ${route.click}`);
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
