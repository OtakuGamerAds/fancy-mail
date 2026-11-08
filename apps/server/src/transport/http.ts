/**
 * The HTTP side: health, the session cookie, attachments, uploads, /mcp (mounted by the MCP
 * module), and the built UI. Each route decodes input, calls one service, maps errors.
 */
import fs from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { ServerConfig } from "../config.ts";
import { AppError, isAppError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { Services } from "../services/index.ts";
import { MAX_UPLOAD_BYTES } from "../services/files.ts";
import type { Auth } from "./auth.ts";

export type McpHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; " +
  "font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-src 'self' about: blob:; " +
  "object-src 'none'; base-uri 'none'";

/** Shown inline in the app; everything else downloads, sandboxed. */
const INLINE_SAFE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "application/pdf",
  "text/plain",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
]);

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const STATUS: Record<string, number> = {
  bad_request: 400,
  not_found: 404,
  forbidden: 403,
  auth_failed: 401,
  connection_failed: 502,
  conflict: 409,
  internal: 500,
};

export interface HttpServer {
  server: http.Server;
  setMcpHandler(handler: McpHandler | null): void;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown, log: Logger): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (isAppError(error)) {
    sendJson(res, STATUS[error.code] ?? 500, { code: error.code, message: error.message });
    return;
  }
  log.error("request failed", { error });
  sendJson(res, 500, { code: "internal", message: `Something went wrong: ${error instanceof Error ? error.message : String(error)}` });
}

/** `inline; filename="ascii"; filename*=UTF-8''utf8` */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_") || "file";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  meta: { filename: string; mimeType: string },
  download: boolean,
): void {
  const mime = meta.mimeType.toLowerCase().split(";")[0]!.trim();
  const safe = INLINE_SAFE.has(mime);
  const disposition = download || !safe ? "attachment" : "inline";
  const stat = fs.statSync(file);
  const headers: Record<string, string | number> = {
    "Content-Type": safe ? mime : mime || "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": contentDisposition(disposition, meta.filename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
  };
  if (!safe) headers["Content-Security-Policy"] = "sandbox";
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError("bad_request", "Attachments can be at most 35 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createHttpServer(deps: { services: Services; auth: Auth; config: ServerConfig; log: Logger }): HttpServer {
  const { services, auth, config, log } = deps;
  let mcpHandler: McpHandler | null = null;
  const webDist = config.webDist ? path.resolve(config.webDist) : null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // DNS rebinding: only requests addressed to this server by name.
    if (!auth.hostAllowed(req)) {
      sendJson(res, 403, { code: "forbidden", message: "This server only answers on 127.0.0.1 and localhost." });
      return;
    }

    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      if (!mcpHandler) {
        sendJson(res, 503, { error: "mcp_unavailable", message: "The MCP server is starting." });
        return;
      }
      await mcpHandler(req, res);
      return;
    }

    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, version: config.version });
      return;
    }

    // ?t=<token> signs the browser in.
    const t = url.searchParams.get("t");
    if (pathname === "/api/session") {
      if (t && auth.tokenMatches(t)) {
        res.writeHead(204, { "Set-Cookie": auth.cookie(), "Cache-Control": "no-store" });
        res.end();
      } else if (auth.hasSession(req)) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
      } else {
        sendJson(res, 401, { code: "auth_failed", message: "That session link is no longer valid. Open Fancy Mail again." });
      }
      return;
    }
    if (t !== null && (method === "GET" || method === "HEAD")) {
      url.searchParams.delete("t");
      const location = `${url.pathname}${url.search}${url.hash}`;
      const headers: Record<string, string> = { Location: location, "Cache-Control": "no-store" };
      if (auth.tokenMatches(t)) headers["Set-Cookie"] = auth.cookie();
      res.writeHead(302, headers);
      res.end();
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (!auth.hasSession(req)) {
        sendJson(res, 401, { code: "auth_failed", message: "Not signed in to Fancy Mail. Reload the app." });
        return;
      }
      if (method !== "GET" && method !== "HEAD" && !auth.originAllowed(req.headers.origin)) {
        sendJson(res, 403, { code: "forbidden", message: "Requests from other sites are not allowed." });
        return;
      }
      await handleApi(req, res, url, method);
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { code: "bad_request", message: "Method not allowed." });
      return;
    }
    serveStatic(req, res, pathname);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
    if ((method === "GET" || method === "HEAD") && parts[1] === "attachments" && parts.length === 3) {
      const { path: file, meta } = await services.attachments.open(parts[2]!);
      streamFile(req, res, file, meta, url.searchParams.get("download") === "1");
      return;
    }
    if ((method === "GET" || method === "HEAD") && parts[1] === "messages" && parts[3] === "cid" && parts.length === 5) {
      const meta = services.attachments.byContentId(parts[2]!, parts[4]!);
      const { path: file } = await services.attachments.open(meta.id);
      streamFile(req, res, file, meta, false);
      return;
    }
    if (method === "POST" && parts[1] === "uploads" && parts.length === 2) {
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > MAX_UPLOAD_BYTES) {
        sendJson(res, 413, { code: "bad_request", message: "Attachments can be at most 35 MB." });
        req.resume();
        return;
      }
      let filename = "attachment";
      const header = req.headers["x-filename"];
      if (typeof header === "string" && header) {
        try {
          filename = decodeURIComponent(header);
        } catch {
          filename = header;
        }
      }
      const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
      const body = await readBody(req, MAX_UPLOAD_BYTES);
      sendJson(res, 200, await services.uploads.save(body, filename, mime));
      return;
    }
    sendJson(res, 404, { code: "not_found", message: `No route ${method} ${url.pathname}.` });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (!webDist) {
      const html =
        '<!doctype html><meta charset="utf-8"><title>Fancy Mail</title>' +
        '<body style="font-family:system-ui;background:#0b0b0c;color:#e5e5e5;padding:40px">' +
        "<h1 style=\"font-weight:500\">Fancy Mail server</h1><p>The UI is served by Vite in dev (http://localhost:5190).</p></body>";
      res.writeHead(pathname === "/" ? 200 : 404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : html);
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      relative = pathname;
    }
    let file = path.resolve(webDist, `.${relative}`);
    if (!file.startsWith(webDist + path.sep) && file !== webDist) {
      sendJson(res, 404, { code: "not_found", message: "Not found." });
      return;
    }
    let stat = statOrNull(file);
    if (stat?.isDirectory()) {
      file = path.join(file, "index.html");
      stat = statOrNull(file);
    }
    if (!stat) {
      // SPA fallback for app routes; real missing files (with an extension) are 404.
      if (path.extname(relative)) {
        sendJson(res, 404, { code: "not_found", message: "Not found." });
        return;
      }
      file = path.join(webDist, "index.html");
      stat = statOrNull(file);
      if (!stat) {
        sendJson(res, 404, { code: "not_found", message: "The UI build is missing." });
        return;
      }
    }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === ".html";
    const headers: Record<string, string | number> = {
      "Content-Type": STATIC_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": stat.size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": isHtml ? "no-cache" : /[-.][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg)$/.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (isHtml) {
      headers["Content-Security-Policy"] = CSP;
      headers["Referrer-Policy"] = "no-referrer";
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => sendError(res, error, log));
  });
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 30_000;

  return {
    server,
    setMcpHandler(handler) {
      mcpHandler = handler;
    },
  };
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
