/**
 * What went wrong talking to a mail server, in words for a person. Every error the engine sees
 * is classified here into one of three kinds:
 *
 *   auth     the server refused the credentials: stop retrying, keep them, ask to reconnect
 *   network  DNS, refused connections, timeouts, TLS, dropped sockets: retry with backoff
 *   other    the server said NO to one command: the caller decides (an outbox op retries)
 *
 * Messages are built from templates and the server's own response text, never from the command
 * that was sent (a LOGIN line carries the password).
 */
import type { Provider } from "@fancy-mail/contracts";

export type SyncErrorKind = "auth" | "network" | "other";

export interface ErrorContext {
  /** The server that was being talked to. */
  host: string;
  provider: Provider;
  /** "test": adding/reconnecting an account (the person is waiting). "background": a worker. */
  mode: "test" | "background";
  /** Which protocol failed. */
  protocol: "imap" | "smtp" | "oauth";
  email?: string;
}

export interface ClassifiedError {
  kind: SyncErrorKind;
  message: string;
}

/** An OAuth token endpoint refused the refresh token (revoked, expired, password changed). */
export class OAuthGrantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OAuthGrantError";
    this.code = code;
  }
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ETIMEOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ESOCKET",
  "ECONNECTION",
  "EDNS",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "NoConnection",
  "EConnectionClosed",
  "ClosedAfterConnectText",
  "ClosedAfterConnectTLS",
  "StateLogout",
  "ETHROTTLE",
  "ESTREAM",
  "EPROXY",
  "ProxyError",
]);

const TLS_CODES = /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS|ERR_SSL|EPROTO|HOSTNAME_MISMATCH)/;

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  authenticationFailed?: unknown;
  serverResponseCode?: unknown;
  responseText?: unknown;
  response?: unknown;
  responseCode?: unknown;
  tlsFailed?: unknown;
  oauthError?: unknown;
  cause?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The server's words (response text), without a leading tag/status or IMAP response code. */
export function serverText(error: unknown): string {
  const e = (error ?? {}) as ErrorLike;
  let text = str(e.responseText) || (typeof e.response === "string" ? e.response : "") || "";
  text = text
    .replace(/^\S+\s+(NO|BAD|BYE)\s+/i, "")
    .replace(/^\d{3}[\s-](\d\.\d\.\d+\s+)?/, "")
    .replace(/\[[A-Z-]+[^\]]*\]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

function allText(error: unknown): string {
  const e = (error ?? {}) as ErrorLike;
  return [str(e.message), str(e.responseText), typeof e.response === "string" ? e.response : "", str(e.serverResponseCode)].join(" ");
}

function codeOf(error: unknown): string {
  const e = (error ?? {}) as ErrorLike;
  const code = str(e.code);
  if (code) return code;
  const cause = e.cause as ErrorLike | undefined;
  return cause ? str(cause.code) : "";
}

export function isAuthError(error: unknown): boolean {
  if (error instanceof OAuthGrantError) return true;
  const e = (error ?? {}) as ErrorLike;
  if (e.authenticationFailed === true) return true;
  const rc = str(e.serverResponseCode).toUpperCase();
  if (rc === "AUTHENTICATIONFAILED" || rc === "AUTHORIZATIONFAILED") return true;
  if (str(e.code) === "EAUTH") return true;
  if (e.responseCode === 535 || e.responseCode === 534) return true;
  const text = allText(error);
  return /invalid credentials|authentication failed|AUTHENTICATIONFAILED|application-specific password required|invalid_grant|LOGIN failed|AUTHENTICATE failed|web login required|not enabled for IMAP/i.test(
    text,
  );
}

export function isNetworkError(error: unknown): boolean {
  const code = codeOf(error);
  if (NETWORK_CODES.has(code) || TLS_CODES.test(code)) return true;
  const e = (error ?? {}) as ErrorLike;
  if (e.tlsFailed === true) return true;
  return /socket hang up|connection (closed|lost|reset)|timed? ?out|unexpected close|wrong version number|ECONNRESET|getaddrinfo/i.test(str(e.message));
}

function isTls(error: unknown): boolean {
  const e = (error ?? {}) as ErrorLike;
  return e.tlsFailed === true || TLS_CODES.test(codeOf(error)) || /wrong version number|certificate|SSL routines|tls/i.test(str(e.message));
}

const GOOGLE_HOSTS = /(^|\.)(gmail|googlemail|google)\.com$/i;

function isGoogle(ctx: ErrorContext): boolean {
  return ctx.provider === "gmail" || GOOGLE_HOSTS.test(ctx.host);
}

function isMicrosoft(ctx: ErrorContext): boolean {
  return ctx.provider === "outlook" || /office365\.com$|outlook\.com$/i.test(ctx.host);
}

/** The auth failure, in words that say what to do. */
function authMessage(error: unknown, ctx: ErrorContext): string {
  const text = allText(error);
  if (error instanceof OAuthGrantError || /invalid_grant/i.test(text)) {
    return isMicrosoft(ctx)
      ? "Microsoft ended this sign-in (it happens after a password change or when access is removed). Sign in again to reconnect."
      : "Google ended this sign-in (it happens after a password change or when access is removed). Sign in again to reconnect.";
  }
  if (isGoogle(ctx)) {
    if (/application-specific password required/i.test(text)) {
      return "Google needs an app password here, not your Google password. Make one at myaccount.google.com/apppasswords and use that.";
    }
    if (/web login required|log ?in via your web browser/i.test(text)) {
      return "Google blocked this sign-in. Open Gmail in your browser once, confirm it was you, then try again.";
    }
    if (/not enabled for IMAP/i.test(text)) {
      return "IMAP is turned off for this Gmail account. Turn it on in Gmail settings › Forwarding and POP/IMAP, then try again.";
    }
    if (ctx.protocol === "oauth" || /XOAUTH|oauth/i.test(text)) {
      return "Google didn't accept the sign-in. Sign in again to reconnect.";
    }
    return ctx.mode === "test"
      ? "Google refused the password. Gmail needs an app password (myaccount.google.com/apppasswords), not your Google password."
      : "Google refused the app password. It stops working when you change your Google password — make a new one and reconnect.";
  }
  if (isMicrosoft(ctx)) {
    return "Microsoft refused the sign-in. Sign in again to reconnect.";
  }
  const who = ctx.email ? ` for ${ctx.email}` : "";
  const said = serverText(error);
  const base =
    ctx.protocol === "smtp"
      ? `The server ${ctx.host} refused the password${who} for sending mail.`
      : `The server ${ctx.host} refused the user name or password${who}.`;
  return `${base}${said && !/password|credential|auth/i.test(said) ? ` It said: “${said}”.` : ""} Check them and ${ctx.mode === "test" ? "try again" : "reconnect"}.`;
}

function networkMessage(error: unknown, ctx: ErrorContext): string {
  const code = codeOf(error);
  const tail = ctx.mode === "background" ? " — will keep trying." : ".";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EDNS") {
    return ctx.mode === "test"
      ? `Can't find the server ${ctx.host}. Check the server name and your internet connection.`
      : `Can't reach ${ctx.host}${tail}`;
  }
  if (isTls(error)) {
    return ctx.mode === "test"
      ? `The secure connection to ${ctx.host} failed. Check the port and the security setting (SSL/TLS or STARTTLS).`
      : `The secure connection to ${ctx.host} failed${tail}`;
  }
  if (code === "ECONNREFUSED") {
    return ctx.mode === "test"
      ? `${ctx.host} refused the connection. Check the port number.`
      : `Can't reach ${ctx.host}${tail}`;
  }
  if (code === "ETHROTTLE") return `${ctx.host} asked Fancy Mail to slow down${tail}`;
  if (/TIMEOUT|ETIMEDOUT/i.test(code)) {
    return ctx.mode === "test"
      ? `${ctx.host} didn't answer in time. Check the server name and port, and your internet connection.`
      : `Can't reach ${ctx.host}${tail}`;
  }
  return `Can't reach ${ctx.host}${tail}`;
}

/** Classifies an error and writes the message a person sees. */
export function classifyError(error: unknown, ctx: ErrorContext): ClassifiedError {
  if (isAuthError(error)) return { kind: "auth", message: authMessage(error, ctx) };
  if (isNetworkError(error)) return { kind: "network", message: networkMessage(error, ctx) };
  const said = serverText(error);
  const what = ctx.protocol === "smtp" ? "The mail server" : ctx.host;
  return {
    kind: "other",
    message: said ? `${what} said: “${said}”` : `Something went wrong talking to ${ctx.host}.`,
  };
}

/**
 * A send failure in words: which recipient was refused and why, or why the server refused the
 * message. Never mentions credentials beyond "the password".
 */
export function smtpSendMessage(error: unknown, ctx: ErrorContext): string {
  const e = (error ?? {}) as ErrorLike & { rejected?: unknown; rejectedErrors?: unknown; command?: unknown };
  if (isAuthError(error)) {
    return `${authMessage(error, { ...ctx, protocol: "smtp" })} The message wasn't sent.`;
  }
  if (isNetworkError(error)) {
    return `Couldn't reach ${ctx.host} to send. The message wasn't sent — try again when you're online.`;
  }
  const rejected = Array.isArray(e.rejected) ? (e.rejected as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const said = serverText(error);
  if (rejected.length > 0 || str(e.code) === "EENVELOPE") {
    const who = rejected.length === 1 ? rejected[0] : rejected.length > 1 ? `${rejected[0]} and ${rejected.length - 1} more` : "a recipient";
    return `The server refused the recipient ${who}${said ? `: ${said}` : ""}. The message wasn't sent.`;
  }
  if (e.responseCode === 552 || /size|too large/i.test(said)) {
    return `The message is too big for the server${said ? ` (${said})` : ""}. Remove an attachment and try again.`;
  }
  if (said) return `The server refused the message: ${said}. It wasn't sent.`;
  return "Sending failed. The message wasn't sent — try again.";
}
