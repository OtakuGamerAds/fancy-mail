/**
 * End-to-end check of a running server over the real WebSocket RPC.
 *
 *   node scripts/electron-node.mjs apps/server/scripts/smoke.ts
 *       starts its own server on a temp data dir (demo data), runs the checks, stops it
 *   node scripts/electron-node.mjs apps/server/scripts/smoke.ts --url http://127.0.0.1:47822 --token <sessionToken>
 *       runs the checks against a server that is already running (changes are undone again)
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function startServer(): Promise<{ url: string; token: string; child: ChildProcess; dataDir: string }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-smoke-"));
  const child = spawn(process.execPath, [path.join(here, "..", "src", "bin.ts"), "--data-dir", dataDir, "--port", "0", "--dev"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const ready = await new Promise<{ url: string; sessionToken: string }>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`server did not start in 30 s\n${stderr}`)), 30_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n")[0];
      if (out.includes("\n") && line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as { url: string; sessionToken: string });
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}\n${stderr}`)));
  });
  return { url: ready.url, token: ready.sessionToken, child, dataDir };
}

class Rpc {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  events: { type: string }[] = [];

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { id?: number; ok?: boolean; result?: unknown; error?: { code: string; message: string }; event?: { type: string } };
      if (frame.event) {
        this.events.push(frame.event);
        return;
      }
      const p = this.#pending.get(frame.id!);
      if (!p) return;
      this.#pending.delete(frame.id!);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(`${frame.error!.code}: ${frame.error!.message}`));
    });
  }

  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function main(): Promise<void> {
  const own = arg("--url") ? null : await startServer();
  const url = arg("--url") ?? own!.url;
  const token = arg("--token") ?? own!.token;
  const rows: [string, string][] = [];
  const t0 = performance.now();
  let failed = false;
  const check = (name: string, ok: boolean, detail: string) => {
    rows.push([`${ok ? "PASS" : "FAIL"}  ${name}`, detail]);
    if (!ok) failed = true;
  };

  try {
    const health = (await (await fetch(`${url}/api/health`)).json()) as { ok: boolean; version: string };
    check("GET /api/health", health.ok, `version ${health.version}`);

    const session = await fetch(`${url}/api/session?t=${encodeURIComponent(token)}`);
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    check("GET /api/session sets the cookie", session.status === 204 && cookie.startsWith("fm_session="), `status ${session.status}`);
    const unauth = await fetch(`${url}/api/attachments/att_x`);
    check("API without the cookie is refused", unauth.status === 401, `status ${unauth.status}`);

    const ws = new WebSocket(`${url.replace("http", "ws")}/ws`, { headers: { Cookie: cookie, Origin: url } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const rpc = new Rpc(ws);

    const boot = await rpc.call("app.bootstrap");
    check(
      "app.bootstrap",
      boot.accounts.length > 0,
      `${boot.accounts.length} accounts, ${boot.groups.length} groups, ${boot.labels.length} labels, ${boot.mailboxes.length} mailboxes, demo=${boot.hasDemoData}`,
    );

    const timed = async (query: string) => {
      const start = performance.now();
      const r = await rpc.call("threads.search", { query, limit: 50 });
      return { r, ms: Math.round(performance.now() - start) };
    };
    const inbox = await timed("in:inbox");
    check('search "in:inbox"', inbox.r.total > 0, `${inbox.r.total} conversations, ${inbox.ms} ms, next page: ${inbox.r.nextCursor ? "yes" : "no"}`);
    if (inbox.r.nextCursor) {
      const page2 = await rpc.call("threads.search", { query: "in:inbox", limit: 50, cursor: inbox.r.nextCursor });
      const overlap = page2.threads.some((t: { id: string }) => inbox.r.threads.some((u: { id: string }) => u.id === t.id));
      check("search paging", !overlap && page2.threads.length > 0, `page 2: ${page2.threads.length} conversations, no overlap`);
    }
    const invoices = await timed("label:Invoices");
    check('search "label:Invoices"', invoices.r.total > 0, `${invoices.r.total} conversations, ${invoices.ms} ms`);
    const rechnung = await timed("rechnung has:attachment");
    check('search "rechnung has:attachment"', rechnung.r.total > 0, `${rechnung.r.total} conversations, ${rechnung.ms} ms — e.g. ${rechnung.r.threads[0]?.subject}`);
    const bad = await timed("label:Nonexistent");
    check("unknown label explains itself", bad.r.total === 0 && bad.r.queryErrors.length === 1, bad.r.queryErrors[0] ?? "");

    const first = rechnung.r.threads[0] ?? inbox.r.threads[0];
    const detail = await rpc.call("threads.get", { threadId: first.id });
    const att = detail.messages.flatMap((m: { attachments: { id: string; filename: string; inline: boolean }[] }) => m.attachments).find((a: { inline: boolean }) => !a.inline);
    check(
      "threads.get",
      detail.messages.length > 0 && detail.messages.every((m: { body: unknown }) => m.body !== null),
      `“${detail.thread.subject}”: ${detail.messages.length} messages, bodies present, ${att ? `attachment ${att.filename}` : "no attachment"}`,
    );
    if (att) {
      const file = await fetch(`${url}/api/attachments/${att.id}`, { headers: { Cookie: cookie } });
      const bytes = Buffer.from(await file.arrayBuffer());
      check(
        "GET /api/attachments/:id",
        file.status === 200 && bytes.subarray(0, 5).toString() === "%PDF-",
        `${file.status} ${file.headers.get("content-type")} ${bytes.length} bytes, ${file.headers.get("content-disposition")}`,
      );
    }

    // Archive the first five inbox conversations, then undo.
    const ids = inbox.r.threads.slice(0, 5).map((t: { id: string }) => t.id);
    const before = (await rpc.call("threads.search", { query: "in:inbox", limit: 1 })).total;
    const modified = await rpc.call("threads.modify", { threadIds: ids, actions: [{ type: "archive" }] });
    const during = (await rpc.call("threads.search", { query: "in:inbox", limit: 1 })).total;
    check("threads.modify archive", modified.activity !== null && during === before - ids.length, `“${modified.activity?.summary}” — inbox ${before} → ${during}`);
    const undone = await rpc.call("activity.undo", { activityId: modified.activity.id });
    const after = (await rpc.call("threads.search", { query: "in:inbox", limit: 1 })).total;
    check("activity.undo", undone.undoneAt !== null && after === before, `inbox back to ${after}`);

    await new Promise((r) => setTimeout(r, 120)); // let the coalesced invalidation arrive
    const kinds = [...new Set(rpc.events.map((e) => e.type))];
    check("server events pushed", kinds.includes("invalidate") && kinds.includes("activity"), kinds.join(", "));

    const badParams = await rpc.call("threads.get", {}).catch((e: Error) => e.message);
    check("invalid params are refused", String(badParams).startsWith("bad_request"), String(badParams));

    ws.close();
  } catch (error) {
    check("smoke run", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    if (own) {
      own.child.kill("SIGTERM");
      await new Promise((r) => own.child.once("exit", r));
      fs.rmSync(own.dataDir, { recursive: true, force: true });
    }
  }

  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [name, detail] of rows) console.log(`${name.padEnd(width)}  ${detail}`);
  console.log(`\n${failed ? "SMOKE FAILED" : "SMOKE OK"} in ${Math.round(performance.now() - t0)} ms against ${url}`);
  process.exit(failed ? 1 : 0);
}

void main();
