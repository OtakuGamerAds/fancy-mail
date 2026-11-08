/**
 * "Sign in with Google / Microsoft": the loopback flow for desktop apps (RFC 8252) with PKCE
 * (S256) and a state check. A one-shot HTTP listener on 127.0.0.1 (random port) receives the
 * redirect; it gives up after 10 minutes or when canceled.
 *
 * The refresh token is kept in the vault ("oauth-refresh"); access tokens live in memory only
 * and are refreshed when less than 2 minutes are left. A refused refresh (invalid_grant) means
 * the person has to sign in again: the account goes to "auth-required", nothing is deleted.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { COLOR_PALETTE, GMAIL_PRESET, PROVIDER_PRESETS } from "@fancy-mail/contracts";
import type { AccountStatus, Settings } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../log.ts";
import type { EventBus } from "../services/bus.ts";
import type { Vault } from "../services/vault.ts";
import type { Store } from "../store/index.ts";
import type { AccountRecord } from "../store/types.ts";
import { OAuthGrantError } from "./errors.ts";

export type OAuthProvider = "google" | "microsoft";

const FLOW_TIMEOUT_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 2 * 60_000;

interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string | null;
  redirectHost: string;
  extraAuthParams: Record<string, string>;
}

export function providerConfig(provider: OAuthProvider, settings: Settings["oauth"]): ProviderConfig {
  if (provider === "google") {
    const clientId = settings.googleClientId.trim();
    if (!clientId) {
      throw new AppError("bad_request", "Sign in with Google needs a client ID first. Add it in Settings › Sign in with Google, or add the account with an app password.");
    }
    return {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "https://mail.google.com/ openid email profile",
      clientId,
      clientSecret: settings.googleClientSecret.trim() || null,
      redirectHost: "127.0.0.1",
      extraAuthParams: { access_type: "offline", prompt: "consent" },
    };
  }
  const clientId = settings.microsoftClientId.trim();
  if (!clientId) {
    throw new AppError("bad_request", "Sign in with Microsoft needs a client ID first. Add it in Settings › Sign in with Google (Microsoft client ID).");
  }
  return {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access openid email profile https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
    clientId,
    clientSecret: null,
    redirectHost: "localhost",
    extraAuthParams: { prompt: "select_account" },
  };
}

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** The claims of an id_token (it came straight from the token endpoint over TLS). */
export function idTokenClaims(idToken: string | undefined): { email: string | null; name: string | null } {
  if (!idToken) return { email: null, name: null };
  const part = idToken.split(".")[1];
  if (!part) return { email: null, name: null };
  try {
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const email = typeof claims.email === "string" ? claims.email : typeof claims.preferred_username === "string" ? claims.preferred_username : null;
    const name = typeof claims.name === "string" ? claims.name : null;
    return { email: email && email.includes("@") ? email : null, name };
  } catch {
    return { email: null, name: null };
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let json: TokenResponse;
  try {
    json = (await response.json()) as TokenResponse;
  } catch {
    json = {};
  }
  if (!response.ok || json.error) {
    const code = json.error ?? `http_${response.status}`;
    if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") {
      throw new OAuthGrantError(code, "The sign-in was refused");
    }
    throw Object.assign(new Error(`The token endpoint answered ${response.status}`), { code: response.status >= 500 ? "ECONNRESET" : code });
  }
  return json;
}

const PAGE = (title: string, text: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0b0b0d; color: #e7e7ea;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { height: 100%; display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
  section { max-width: 420px; text-align: center; padding: 32px 28px; border-radius: 14px;
    background: #141418; border: 1px solid #26262c; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #a1a1aa; }
</style></head>
<body><main><section><h1>${title}</h1><p>${text}</p></section></main></body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface Flow {
  id: string;
  provider: OAuthProvider;
  accountId: string | undefined;
  groupId: string | null | undefined;
  state: string;
  verifier: string;
  redirectUri: string;
  config: ProviderConfig;
  servers: http.Server[];
  timer: ReturnType<typeof setTimeout>;
  done: boolean;
}

export interface OAuthDeps {
  store: Store;
  vault: Vault;
  bus: EventBus;
  log: Logger;
  settings: () => Settings;
  now: () => number;
  /** A new account was created, or an existing one got fresh credentials. */
  onAccount(accountId: string, created: boolean): void;
  /** The account records changed (publish invalidations). */
  invalidate(): void;
}

export function createOAuth(deps: OAuthDeps) {
  const flows = new Map<string, Flow>();
  const tokens = new Map<string, { accessToken: string; expiresAt: number }>();
  const refreshing = new Map<string, Promise<string>>();

  function closeFlow(flow: Flow): void {
    clearTimeout(flow.timer);
    for (const server of flow.servers) {
      server.close();
      server.closeAllConnections();
    }
    flows.delete(flow.id);
  }

  function finish(flow: Flow, ok: boolean, accountId: string | null, error: string | null): void {
    if (flow.done) return;
    flow.done = true;
    closeFlow(flow);
    deps.bus.publish({ type: "oauthFinished", flowId: flow.id, ok, accountId, error });
  }

  function nextColor(): string {
    const used = deps.store.accounts.list().map((a) => a.color);
    return COLOR_PALETTE.find((c) => !used.includes(c)) ?? COLOR_PALETTE[used.length % COLOR_PALETTE.length]!;
  }

  /** Creates or updates the account for a finished sign-in. Returns its id. */
  function saveAccount(flow: Flow, email: string, name: string | null, refreshToken: string, accessToken: string, expiresIn: number): string {
    const { store } = deps;
    const authKind = flow.provider === "google" ? "oauth-google" : "oauth-microsoft";
    const provider = flow.provider === "google" ? "gmail" : "outlook";
    const preset = flow.provider === "google" ? GMAIL_PRESET : PROVIDER_PRESETS.find((p) => p.id === "outlook")!;
    let target: AccountRecord | null = flow.accountId ? store.accounts.get(flow.accountId) : store.accounts.findByEmail(email);
    if (flow.accountId && !target) throw new AppError("not_found", "The account to sign in again was removed meanwhile.");
    if (target && target.email.toLowerCase() !== email.toLowerCase()) {
      throw new AppError("bad_request", `You signed in as ${email}, but this account is ${target.email}. Sign in with ${target.email}.`);
    }
    if (target && !flow.accountId && target.authKind === "password") {
      throw new AppError("conflict", `${email} is already in Fancy Mail (with a password). Remove it first to switch to signing in with ${flow.provider === "google" ? "Google" : "Microsoft"}.`);
    }
    const connecting: AccountStatus = { state: "connecting", message: "Connecting…", lastSyncAt: target?.status.lastSyncAt ?? null, progress: null };
    let id: string;
    let created = false;
    store.db.tx(() => {
      if (target) {
        id = target.id;
        store.accounts.update(id, { authKind, imap: target.imap ?? preset.imap, smtp: target.smtp ?? preset.smtp, username: email });
        store.accounts.setStatus(id, connecting);
      } else {
        id = newId("acc");
        created = true;
        const groupId = flow.groupId && store.groups.get(flow.groupId) ? flow.groupId : null;
        store.accounts.insert({
          id,
          email,
          displayName: name?.trim() || email,
          username: email,
          provider,
          authKind,
          groupId,
          color: nextColor(),
          sortOrder: store.accounts.nextSortOrder(groupId),
          agentAccess: deps.settings().defaultAgentAccess,
          signature: "",
          imap: preset.imap,
          smtp: preset.smtp,
          status: connecting,
          paused: false,
          isDemo: false,
          createdAt: deps.now(),
        });
      }
      deps.vault.put(id, "oauth-refresh", refreshToken);
    });
    tokens.set(id!, { accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    deps.log.addSecret(refreshToken);
    deps.log.addSecret(accessToken);
    deps.bus.publish({ type: "accountStatus", accountId: id!, status: connecting });
    deps.invalidate();
    deps.onAccount(id!, created);
    return id!;
  }

  async function handleCallback(flow: Flow, url: URL, res: http.ServerResponse): Promise<void> {
    const send = (status: number, title: string, text: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE(escapeHtml(title), escapeHtml(text)));
    };
    if (url.searchParams.get("state") !== flow.state) {
      send(400, "This sign-in link doesn't match", "Start the sign-in again from Fancy Mail.");
      return;
    }
    const error = url.searchParams.get("error");
    if (error) {
      const canceled = error === "access_denied";
      send(200, canceled ? "Sign-in canceled" : "Sign-in failed", "You can close this tab and go back to Fancy Mail.");
      finish(flow, false, null, canceled ? "The sign-in was canceled." : "The provider refused the sign-in. Try again.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      send(400, "Sign-in failed", "The answer had no code. Start the sign-in again from Fancy Mail.");
      finish(flow, false, null, "The sign-in didn't complete. Try again.");
      return;
    }
    try {
      const body: Record<string, string> = {
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: flow.config.clientId,
        code_verifier: flow.verifier,
      };
      if (flow.config.clientSecret) body.client_secret = flow.config.clientSecret;
      if (flow.provider === "microsoft") body.scope = flow.config.scope;
      const token = await postToken(flow.config.tokenUrl, body);
      if (!token.access_token) throw new Error("no access token");
      if (!token.refresh_token) {
        throw new AppError("auth_failed", "The provider didn't grant lasting access, so Fancy Mail would be signed out within an hour. Try again and allow access.");
      }
      deps.log.addSecret(token.access_token);
      deps.log.addSecret(token.refresh_token);
      const claims = idTokenClaims(token.id_token);
      if (!claims.email) throw new AppError("auth_failed", "The sign-in didn't say which address it was for. Try again.");
      const accountId = saveAccount(flow, claims.email, claims.name, token.refresh_token, token.access_token, token.expires_in ?? 3600);
      send(200, "You're signed in", "You're signed in. You can close this tab and go back to Fancy Mail.");
      finish(flow, true, accountId, null);
    } catch (e) {
      const message = e instanceof AppError ? e.message : "The sign-in couldn't be completed. Check your connection and try again.";
      deps.log.warn("oauth sign-in failed", { provider: flow.provider, error: e instanceof Error ? e.message : String(e) });
      send(200, "Sign-in failed", `${message} You can close this tab.`);
      finish(flow, false, null, message);
    }
  }

  function listen(server: http.Server, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  async function refresh(account: AccountRecord): Promise<string> {
    const provider: OAuthProvider = account.authKind === "oauth-microsoft" ? "microsoft" : "google";
    const config = providerConfig(provider, deps.settings().oauth);
    const refreshToken = deps.vault.get(account.id, "oauth-refresh");
    if (!refreshToken) throw new OAuthGrantError("invalid_grant", "No refresh token stored");
    const body: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId };
    if (config.clientSecret) body.client_secret = config.clientSecret;
    if (provider === "microsoft") body.scope = config.scope;
    const token = await postToken(config.tokenUrl, body);
    if (!token.access_token) throw new Error("no access token");
    deps.log.addSecret(token.access_token);
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      deps.log.addSecret(token.refresh_token);
      deps.vault.put(account.id, "oauth-refresh", token.refresh_token);
    }
    tokens.set(account.id, { accessToken: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 });
    return token.access_token;
  }

  return {
    async start(input: { provider: OAuthProvider; accountId?: string; groupId?: string | null }): Promise<{ flowId: string; authUrl: string }> {
      const config = providerConfig(input.provider, deps.settings().oauth);
      if (input.accountId) {
        const account = deps.store.accounts.get(input.accountId);
        if (!account) throw new AppError("not_found", "No such account.");
        if (account.authKind === "password") {
          throw new AppError("bad_request", `${account.email} signs in with a password. Use "Reconnect" and enter the password instead.`);
        }
      }
      const { verifier, challenge } = pkcePair();
      const flow: Flow = {
        id: base64url(randomBytes(12)),
        provider: input.provider,
        accountId: input.accountId,
        groupId: input.groupId,
        state: base64url(randomBytes(16)),
        verifier,
        redirectUri: "",
        config,
        servers: [],
        timer: setTimeout(() => finish(flow, false, null, "The sign-in timed out. Try again."), FLOW_TIMEOUT_MS),
        done: false,
      };
      flow.timer.unref?.();
      const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback" || flow.done) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
          return;
        }
        void handleCallback(flow, url, res);
      };
      const v4 = http.createServer(handler);
      flow.servers.push(v4);
      const port = await listen(v4, "127.0.0.1", 0);
      if (config.redirectHost === "localhost") {
        // "localhost" may resolve to ::1 in the browser: listen there too (best effort).
        const v6 = http.createServer(handler);
        try {
          await listen(v6, "::1", port);
          flow.servers.push(v6);
        } catch {
          v6.close();
        }
      }
      flow.redirectUri = `http://${config.redirectHost}:${port}/callback`;
      flows.set(flow.id, flow);
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: flow.redirectUri,
        response_type: "code",
        scope: config.scope,
        state: flow.state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...config.extraAuthParams,
      });
      if (input.accountId) {
        const email = deps.store.accounts.get(input.accountId)?.email;
        if (email) params.set("login_hint", email);
      }
      return { flowId: flow.id, authUrl: `${config.authUrl}?${params.toString()}` };
    },

    cancel(flowId: string): void {
      const flow = flows.get(flowId);
      if (flow) finish(flow, false, null, "The sign-in was canceled.");
    },

    /** A valid access token for the account (refreshed when it is about to expire). */
    async accessToken(account: AccountRecord): Promise<string> {
      const cached = tokens.get(account.id);
      if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.accessToken;
      let pending = refreshing.get(account.id);
      if (!pending) {
        pending = refresh(account).finally(() => refreshing.delete(account.id));
        refreshing.set(account.id, pending);
      }
      return pending;
    },

    /** Forget the cached access token (the server refused it). */
    invalidateToken(accountId: string): void {
      tokens.delete(accountId);
    },

    forget(accountId: string): void {
      tokens.delete(accountId);
    },

    stop(): void {
      for (const flow of [...flows.values()]) finish(flow, false, null, "Fancy Mail is closing.");
    },
  };
}

export type OAuth = ReturnType<typeof createOAuth>;
