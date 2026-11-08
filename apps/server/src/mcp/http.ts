/**
 * The MCP endpoint: Streamable HTTP on /mcp, one MCP session per connected agent.
 *
 * Auth is a bearer token the user copies from Settings › Agents. Browser origins other than
 * this machine are refused (DNS rebinding). Each session knows which client it is
 * ("claude-code", "t3code"), which becomes the actor of every change it makes.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Actor, McpClient } from "@fancy-mail/contracts";

export interface McpHttpDeps {
  isEnabled(): boolean;
  /** The current token; compared in constant time here. */
  token(): string;
  setClients(clients: McpClient[]): void;
  /** A fresh MCP server whose tools act as `actor()` (read when a tool runs). */
  buildServer(actor: () => Actor): McpServer;
  log: { info(message: string): void; warn(message: string): void };
}

interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  client: McpClient;
}

const IDLE_MS = 30 * 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Agents (CLI processes) send no Origin; a browser page does. Only this machine may. */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("Request body is larger than 4 MB.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((m) => typeof m === "object" && m !== null && (m as { method?: unknown }).method === "initialize");
}

export function createMcpHttpHandler(deps: McpHttpDeps) {
  const sessions = new Map<string, Session>();

  const publishClients = () => {
    deps.setClients([...sessions.values()].map((s) => s.client));
  };

  const closeSession = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    void session.transport.close().catch(() => {});
    void session.server.close().catch(() => {});
    publishClients();
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.client.lastSeenAt > IDLE_MS) closeSession(session.id);
    }
  }, 60_000);
  sweep.unref();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!originAllowed(req.headers.origin)) {
      return sendJson(res, 403, { error: "forbidden_origin", message: "MCP requests from web pages are not allowed." });
    }
    const auth = req.headers.authorization ?? "";
    const presented = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? "";
    if (!presented || !tokenMatches(presented, deps.token())) {
      return sendJson(
        res,
        401,
        {
          error: "invalid_token",
          message: "A valid Fancy Mail token is required. Copy it from Fancy Mail › Settings › Agents.",
        },
        { "www-authenticate": presented ? 'Bearer error="invalid_token"' : "Bearer" },
      );
    }
    if (!deps.isEnabled()) {
      return sendJson(res, 503, {
        error: "agents_disabled",
        message: "Agents are turned off in Fancy Mail › Settings › Agents.",
      });
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        return sendJson(res, 400, { error: "bad_request", message: (error as Error).message });
      }
    }

    if (existing) {
      existing.client.lastSeenAt = Date.now();
      await existing.transport.handleRequest(req, res, body);
      if (req.method === "DELETE") closeSession(existing.id);
      return;
    }

    if (typeof sessionId === "string") {
      // The app restarted or the session idled out: the client must start over.
      return sendJson(res, 404, { error: "session_not_found", message: "This MCP session ended. Reconnect." });
    }
    if (req.method !== "POST" || !isInitialize(body)) {
      return sendJson(res, 400, { error: "bad_request", message: "Start a session with an initialize request." });
    }

    const now = Date.now();
    const client: McpClient = { sessionId: "", name: "agent", version: null, connectedAt: now, lastSeenAt: now };
    let server: McpServer | undefined;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        client.sessionId = id;
        const info = server?.server.getClientVersion();
        if (info?.name) client.name = info.name;
        if (info?.version) client.version = info.version;
        sessions.set(id, { id, transport, server: server!, client });
        publishClients();
      },
    });
    transport.onclose = () => {
      if (client.sessionId) closeSession(client.sessionId);
    };
    // The client names itself in initialize, which completes after the session id is issued:
    // read the name when a tool runs, not when the session starts.
    const refreshClientInfo = () => {
      const info = server?.server.getClientVersion();
      if (info?.name && client.name !== info.name) {
        client.name = info.name;
        client.version = info.version ?? null;
        if (client.sessionId) publishClients();
      }
    };
    server = deps.buildServer(() => {
      refreshClientInfo();
      return { kind: "agent", name: client.name };
    });
    server.server.oninitialized = () => {
      refreshClientInfo();
      deps.log.info(`Agent connected: ${client.name}${client.version ? ` ${client.version}` : ""}`);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return {
    handle: (req: IncomingMessage, res: ServerResponse) => {
      handle(req, res).catch((error: unknown) => {
        deps.log.warn(`MCP request failed: ${(error as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal", message: "The MCP request failed." });
        else res.end();
      });
    },
    clients: () => [...sessions.values()].map((s) => s.client),
    close: () => {
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) closeSession(id);
    },
  };
}
