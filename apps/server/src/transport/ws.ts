/**
 * WebSocket RPC on /ws. Frames are JSON per contracts/rpc.ts: `{ id, method, params }` in,
 * `{ id, ok, result | error }` and `{ event }` out. Each method validates its params with the
 * contract schema and calls one service method. Invalidations are coalesced per client
 * (50 ms) so a burst of changes becomes one refetch.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { RPC_METHODS } from "@fancy-mail/contracts";
import type { InvalidationTopic, RpcMethod, RpcParams, RpcResponse, RpcResult, ServerEvent } from "@fancy-mail/contracts";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

import { AppError, isAppError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { CallContext } from "../services/context.ts";
import type { Services } from "../services/index.ts";
import type { Auth } from "./auth.ts";

type Handler<M extends RpcMethod> = (params: RpcParams<M>, ctx: CallContext) => RpcResult<M> | Promise<RpcResult<M>>;
type HandlerTable = { [M in RpcMethod]: Handler<M> };

const EMPTY = {} as Record<string, never>;

/** Every RPC method → one service call. */
export function rpcHandlers(services: Services): HandlerTable {
  return {
    "app.bootstrap": () => services.bootstrap(),
    "threads.search": (p, ctx) => services.threads.search(p, ctx),
    "threads.facets": (p, ctx) => services.threads.facets(p, ctx),
    "threads.get": (p, ctx) => services.threads.get(p.threadId, ctx),
    "threads.modify": (p, ctx) => services.threads.modify(p.threadIds, p.actions, ctx),
    "threads.fetchBodies": (p, ctx) => (services.threads.fetchBodies(p.threadId, ctx), EMPTY),
    "labels.create": (p, ctx) => services.labels.create(p, ctx),
    "labels.update": (p, ctx) => services.labels.update(p, ctx),
    "labels.delete": (p, ctx) => (services.labels.delete(p, ctx), EMPTY),
    "labels.reorder": (p, ctx) => (services.labels.reorder(p, ctx), EMPTY),
    "groups.create": (p, ctx) => services.groups.create(p, ctx),
    "groups.update": (p, ctx) => services.groups.update(p, ctx),
    "groups.delete": (p, ctx) => (services.groups.delete(p, ctx), EMPTY),
    "groups.reorder": (p, ctx) => (services.groups.reorder(p, ctx), EMPTY),
    "accounts.detect": (p) => services.accounts.detect(p.email),
    "accounts.addWithPassword": (p, ctx) => services.accounts.addWithPassword(p, ctx),
    "accounts.startOAuth": (p, ctx) => services.accounts.startOAuth(p, ctx),
    "accounts.cancelOAuth": (p, ctx) => (services.accounts.cancelOAuth(p, ctx), EMPTY),
    "accounts.reconnect": (p, ctx) => services.accounts.reconnect(p, ctx),
    "accounts.update": (p, ctx) => services.accounts.update(p, ctx),
    "accounts.reorder": (p, ctx) => (services.accounts.reorder(p, ctx), EMPTY),
    "accounts.remove": (p, ctx) => (services.accounts.remove(p, ctx), EMPTY),
    "accounts.syncNow": (p, ctx) => (services.accounts.syncNow(p, ctx), EMPTY),
    "drafts.get": (p, ctx) => services.drafts.get(p.draftId, ctx),
    "drafts.list": (_p, ctx) => services.drafts.list(ctx),
    "drafts.save": (p, ctx) => services.drafts.save(p.draft, ctx),
    "drafts.delete": (p, ctx) => (services.drafts.delete(p.draftId, ctx), EMPTY),
    "drafts.send": (p, ctx) => services.drafts.send(p.draftId, ctx, { undoable: p.undoable ?? false }),
    "drafts.cancelSend": (p, ctx) => services.drafts.cancelSend(p.draftId, ctx),
    "drafts.sendNow": (p, ctx) => (services.drafts.sendNow(p.draftId, ctx), EMPTY),
    "activity.list": (p) => services.activity.list(p),
    "activity.undo": (p, ctx) => services.activity.undo(p.activityId, ctx),
    "settings.update": (p, ctx) => services.settings.update(p.patch, ctx),
    "mcp.info": () => services.mcp.info(),
    "mcp.rotateToken": (_p, ctx) => services.mcp.rotateToken(ctx),
    "demo.remove": (_p, ctx) => (services.demo.remove(ctx), EMPTY),
    "demo.reset": (_p, ctx) => (services.demo.reset(ctx), EMPTY),
  };
}

/** Runs one request frame and returns the response frame (exported for tests). */
export async function dispatch(
  handlers: HandlerTable,
  frame: unknown,
  ctx: CallContext,
  log: Logger,
  options: { validateResults?: boolean } = {},
): Promise<RpcResponse | null> {
  if (!frame || typeof frame !== "object") return null;
  const { id, method, params } = frame as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof id !== "number") return null;
  try {
    if (typeof method !== "string" || !(method in RPC_METHODS)) {
      throw new AppError("bad_request", `Unknown method ${String(method)}.`);
    }
    const spec = RPC_METHODS[method as RpcMethod];
    const parsed = spec.params.safeParse(params ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      throw new AppError("bad_request", `Invalid params for ${method}: ${where}${issue?.message ?? "invalid"}.`);
    }
    const handler = handlers[method as RpcMethod] as Handler<RpcMethod>;
    const result = await handler(parsed.data as never, ctx);
    if (options.validateResults) {
      const check = spec.result.safeParse(result);
      if (!check.success) log.warn("RPC result does not match its contract", { method, issue: check.error.issues[0] });
    }
    return { id, ok: true, result };
  } catch (error) {
    if (isAppError(error)) return { id, ok: false, error: { code: error.code, message: error.message } };
    log.error("RPC failed", { method, error });
    const message = error instanceof Error ? error.message : String(error);
    return { id, ok: false, error: { code: "internal", message: `Something went wrong: ${message}` } };
  }
}

interface ClientState {
  socket: WebSocket;
  alive: boolean;
  pending: { topics: Set<InvalidationTopic>; threadIds: Set<string> | null } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
  clientCount(): number;
}

export function createWsServer(deps: { services: Services; auth: Auth; log: Logger; dev: boolean }): WsServer {
  const { services, auth, log } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const handlers = rpcHandlers(services);
  const clients = new Set<ClientState>();
  const ctx: CallContext = { actor: { kind: "user" } };

  function send(state: ClientState, message: unknown): void {
    if (state.socket.readyState !== WebSocket.OPEN) return;
    state.socket.send(JSON.stringify(message));
  }

  function flush(state: ClientState): void {
    state.timer = null;
    const pending = state.pending;
    state.pending = null;
    if (!pending) return;
    const event: ServerEvent = pending.threadIds
      ? { type: "invalidate", topics: [...pending.topics], threadIds: [...pending.threadIds] }
      : { type: "invalidate", topics: [...pending.topics] };
    send(state, { event });
  }

  function push(state: ClientState, event: ServerEvent): void {
    if (event.type !== "invalidate") {
      send(state, { event });
      return;
    }
    if (!state.pending) {
      state.pending = { topics: new Set(event.topics), threadIds: event.threadIds ? new Set(event.threadIds) : null };
    } else {
      for (const t of event.topics) state.pending.topics.add(t);
      // Without threadIds the event means "everything under these topics".
      if (!event.threadIds) state.pending.threadIds = null;
      else if (state.pending.threadIds) for (const id of event.threadIds) state.pending.threadIds.add(id);
    }
    if (state.pending.threadIds && state.pending.threadIds.size > 2000) state.pending.threadIds = null;
    state.timer ??= setTimeout(() => flush(state), 50);
  }

  const unsubscribe = services.bus.subscribe((event) => {
    for (const state of clients) push(state, event);
  });

  const heartbeat = setInterval(() => {
    for (const state of clients) {
      if (!state.alive) {
        state.socket.terminate();
        continue;
      }
      state.alive = false;
      try {
        state.socket.ping();
      } catch {
        // closed meanwhile
      }
    }
  }, 20_000);
  heartbeat.unref();

  wss.on("connection", (socket: WebSocket) => {
    const state: ClientState = { socket, alive: true, pending: null, timer: null };
    clients.add(state);
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("message", (data: RawData) => {
      state.alive = true;
      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      void dispatch(handlers, frame, ctx, log, { validateResults: deps.dev }).then((response) => {
        if (response) send(state, response);
      });
    });
    socket.on("close", () => {
      if (state.timer) clearTimeout(state.timer);
      clients.delete(state);
    });
    socket.on("error", (error) => log.warn("websocket error", { error }));
  });

  function reject(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws") return false;
      if (!auth.hostAllowed(req) || !auth.originAllowed(req.headers.origin)) {
        reject(socket, 403, "Forbidden");
        return true;
      }
      const t = url.searchParams.get("t");
      if (!auth.hasSession(req) && !(t && auth.tokenMatches(t))) {
        reject(socket, 401, "Unauthorized");
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return true;
    },
    async close() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const state of clients) {
        if (state.timer) clearTimeout(state.timer);
        state.socket.close(1001, "Server closing");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      for (const state of clients) state.socket.terminate();
      clients.clear();
    },
    clientCount: () => clients.size,
  };
}
