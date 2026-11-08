import { randomBytes, timingSafeEqual } from "node:crypto";

import { Settings } from "@fancy-mail/contracts";
import type { McpClient, McpInfo } from "@fancy-mail/contracts";

import { AppError } from "../errors.ts";
import { requireUser } from "./context.ts";
import type { CallContext } from "./context.ts";
import { invalidate } from "./env.ts";
import type { ServiceEnv } from "./env.ts";

const MCP_TOKEN_KEY = "mcp.token";

export function createSettingsService(env: ServiceEnv) {
  return {
    get(): Settings {
      return env.store.settings.get();
    },

    update(patch: Partial<Settings>, ctx: CallContext): Settings {
      requireUser(ctx, "change settings");
      const current = env.store.settings.get();
      const next = Settings.safeParse({ ...current, ...patch });
      if (!next.success) {
        const issue = next.error.issues[0];
        throw new AppError("bad_request", `That setting isn't valid${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}.`);
      }
      const changed: Partial<Settings> = {};
      for (const key of Object.keys(patch) as (keyof Settings)[]) {
        if (patch[key] !== undefined) (changed as Record<string, unknown>)[key] = next.data[key];
      }
      env.store.settings.set(changed);
      invalidate(env, changed.mcp ? ["settings", "mcp"] : ["settings"]);
      return next.data;
    },
  };
}

export function createMcpService(env: ServiceEnv) {
  let clients: McpClient[] = [];

  function token(): string {
    let value = env.store.kv.get(MCP_TOKEN_KEY);
    if (!value) {
      value = `fm_${randomBytes(24).toString("base64url")}`;
      env.store.kv.set(MCP_TOKEN_KEY, value);
    }
    return value;
  }

  const service = {
    info(): McpInfo {
      const settings = env.store.settings.get();
      const port = env.port() || settings.mcp.port;
      return { enabled: settings.mcp.enabled, url: `http://127.0.0.1:${port}/mcp`, token: token(), clients };
    },

    rotateToken(ctx: CallContext): McpInfo {
      requireUser(ctx, "change the agent token");
      env.store.kv.set(MCP_TOKEN_KEY, `fm_${randomBytes(24).toString("base64url")}`);
      env.log.addSecret(token());
      invalidate(env, ["mcp"]);
      return service.info();
    },

    /** Constant-time check of a Bearer token; false while agents are turned off. */
    verifyToken(candidate: string): boolean {
      if (!env.store.settings.get().mcp.enabled) return false;
      const expected = Buffer.from(token(), "utf8");
      const given = Buffer.from(candidate ?? "", "utf8");
      if (given.length !== expected.length) {
        timingSafeEqual(expected, expected);
        return false;
      }
      return timingSafeEqual(expected, given);
    },

    /** The MCP transport keeps this current; the UI shows who is connected. */
    setClients(next: McpClient[]): void {
      clients = next;
      env.bus.publish({ type: "mcpClients", clients });
    },

    /** For the logger's scrubber. */
    currentToken(): string {
      return token();
    },
  };
  return service;
}

export type SettingsService = ReturnType<typeof createSettingsService>;
export type McpService = ReturnType<typeof createMcpService>;
