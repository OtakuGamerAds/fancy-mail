/**
 * The one WebSocket to the local server (same-origin `/ws`, cookie auth). Requests are
 * `{ id, method, params }`; responses `{ id, ok, result | error }`; pushes `{ event }`.
 * Reconnects with backoff (0.5 s → 5 s). Requests made while disconnected wait for the next
 * connection; requests that were already sent when the socket dropped fail, because the server
 * may or may not have applied them.
 */
import type {
  RpcErrorCode,
  RpcMethod,
  RpcParams,
  RpcResult,
  ServerEvent,
} from "@fancy-mail/contracts";

export class RpcClientError extends Error {
  readonly code: RpcErrorCode | "timeout" | "disconnected";
  constructor(code: RpcClientError["code"], message: string) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
  }
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

interface Pending {
  method: string;
  frame: string;
  sent: boolean;
  resolve(value: unknown): void;
  reject(error: RpcClientError): void;
  timer: ReturnType<typeof setTimeout>;
}

const BACKOFF_MS = [500, 1000, 2000, 3500, 5000];
const DEFAULT_TIMEOUT_MS = 45_000;
/** Methods that talk to a mail server before they answer. */
const SLOW_METHODS = new Set<string>(["accounts.addWithPassword", "accounts.reconnect", "accounts.detect"]);

class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventListeners = new Set<(event: ServerEvent) => void>();
  private statusListeners = new Set<() => void>();
  private reconnectListeners = new Set<() => void>();
  private attempt = 0;
  private everOpened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  status: ConnectionStatus = "connecting";

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.ws) this.reconnectNow();
    });
    window.addEventListener("online", () => {
      if (!this.ws) this.reconnectNow();
    });
  }

  private url(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener();
  }

  private reconnectNow() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private connect() {
    if (this.ws) return;
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const wasReconnect = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.setStatus("open");
      for (const [, pending] of this.pending) {
        if (!pending.sent) {
          pending.sent = true;
          ws.send(pending.frame);
        }
      }
      if (wasReconnect) for (const listener of this.reconnectListeners) listener();
    };

    ws.onmessage = (message) => {
      let data: unknown;
      try {
        data = JSON.parse(typeof message.data === "string" ? message.data : "");
      } catch {
        return;
      }
      if (!data || typeof data !== "object") return;
      if ("event" in data) {
        const event = (data as { event: ServerEvent }).event;
        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch (error) {
            console.error("Event handler failed", error);
          }
        }
        return;
      }
      const response = data as { id?: number; ok?: boolean; result?: unknown; error?: { code: RpcErrorCode; message: string } };
      if (typeof response.id !== "number") return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else
        pending.reject(
          new RpcClientError(response.error?.code ?? "internal", response.error?.message ?? "Something went wrong."),
        );
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const [id, pending] of this.pending) {
        if (!pending.sent) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          new RpcClientError("disconnected", "Lost the connection to Fancy Mail before it answered. Try again."),
        );
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // A close event follows; reconnecting happens there.
    };
  }

  private scheduleReconnect() {
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    if (this.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  request<M extends RpcMethod>(method: M, params: RpcParams<M>, options?: { timeoutMs?: number }): Promise<RpcResult<M>> {
    if (!this.started) this.start();
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params });
    const timeoutMs = options?.timeoutMs ?? (SLOW_METHODS.has(method) ? 120_000 : DEFAULT_TIMEOUT_MS);
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(
          new RpcClientError(
            "timeout",
            this.status === "open"
              ? "Fancy Mail did not answer in time. Try again."
              : "Fancy Mail is not reachable right now. It will reconnect by itself.",
          ),
        );
      }, timeoutMs);
      const pending: Pending = {
        method,
        frame,
        sent: false,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      };
      this.pending.set(id, pending);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        pending.sent = true;
        this.ws.send(frame);
      }
    });
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** After a dropped connection came back (not the first connect). */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }
}

export const rpcClient = new RpcClient();

export function rpc<M extends RpcMethod>(method: M, params: RpcParams<M>, options?: { timeoutMs?: number }): Promise<RpcResult<M>> {
  return rpcClient.request(method, params, options);
}

/** A sentence for the user from any error. */
export function errorMessage(error: unknown): string {
  if (error instanceof RpcClientError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}
