/**
 * Who may talk to the local server. A random session token per start (fixed in dev from
 * FANCY_MAIL_DEV_TOKEN) is exchanged for an HttpOnly cookie; API and WebSocket calls need the
 * cookie (or the x-fancy-mail-session header). Host and Origin headers must name this server
 * (DNS-rebinding protection). /mcp has its own Bearer token, checked by the MCP handler.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { VITE_DEV_ORIGIN, VITE_DEV_PORT } from "../config.ts";

export const SESSION_COOKIE = "fm_session";
export const SESSION_HEADER = "x-fancy-mail-session";

export interface Auth {
  readonly token: string;
  /** Call once the port is known. */
  setPort(port: number): void;
  hostAllowed(req: IncomingMessage): boolean;
  /** A missing Origin is fine for plain navigations; a present one must be ours. */
  originAllowed(origin: string | undefined): boolean;
  hasSession(req: IncomingMessage): boolean;
  tokenMatches(candidate: string | null | undefined): boolean;
  cookie(): string;
}

export function createAuth(options: { token: string | null; dev: boolean }): Auth {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const expected = Buffer.from(token, "utf8");
  let hosts = new Set<string>();
  let origins = new Set<string>();

  function tokenMatches(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const given = Buffer.from(candidate, "utf8");
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  }

  return {
    token,
    setPort(port) {
      hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
      if (options.dev) {
        hosts.add(`localhost:${VITE_DEV_PORT}`);
        hosts.add(`127.0.0.1:${VITE_DEV_PORT}`);
        origins.add(VITE_DEV_ORIGIN);
        origins.add(`http://127.0.0.1:${VITE_DEV_PORT}`);
      }
    },
    hostAllowed(req) {
      const host = (req.headers.host ?? "").toLowerCase();
      return hosts.has(host);
    },
    originAllowed(origin) {
      if (origin === undefined) return true;
      return origins.has(origin.toLowerCase());
    },
    hasSession(req) {
      const header = req.headers[SESSION_HEADER];
      if (typeof header === "string" && tokenMatches(header)) return true;
      return tokenMatches(readCookie(req.headers.cookie, SESSION_COOKIE));
    },
    tokenMatches,
    cookie() {
      return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
    },
  };
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}
