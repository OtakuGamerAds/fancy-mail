/**
 * Opening IMAP connections, and the sign-in check used when an account is added.
 *
 * Credentials never travel unencrypted: port 993 is TLS from the first byte, anything else must
 * upgrade with STARTTLS or the connection fails.
 */
import { ImapFlow } from "imapflow";

import type { Provider, ServerEndpoint } from "@fancy-mail/contracts";

import { VERSION } from "../config.ts";
import type { Logger } from "../log.ts";

export type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

export interface ImapClientOptions {
  connectionTimeout?: number;
  greetingTimeout?: number;
  /** Turn auto-IDLE off (one-shot connections). */
  noIdle?: boolean;
}

export function createImapClient(endpoint: ServerEndpoint, auth: ImapAuth, log: Logger, options: ImapClientOptions = {}): ImapFlow {
  const client = new ImapFlow({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    doSTARTTLS: endpoint.secure ? undefined : true,
    auth,
    logger: false,
    emitLogs: false,
    qresync: true,
    clientInfo: { name: "Fancy Mail", version: VERSION },
    connectionTimeout: options.connectionTimeout ?? 30_000,
    greetingTimeout: options.greetingTimeout ?? 20_000,
    // Gmail drops an IDLE after ~29 minutes; restart it well before any server would.
    maxIdleTime: 4 * 60_000,
    disableAutoIdle: options.noIdle ?? false,
    autoIdleDelay: 15_000,
  });
  // An 'error' without a listener would take the whole server down.
  client.on("error", (error: Error) => log.debug("imap connection error", { host: endpoint.host, error: error.message }));
  return client;
}

/** Signs in and out again. Throws the raw error (classify it with errors.ts). */
export async function checkImapLogin(endpoint: ServerEndpoint, auth: ImapAuth, log: Logger, timeoutMs = 20_000): Promise<{ gmail: boolean }> {
  const client = createImapClient(endpoint, auth, log, { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, noIdle: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("The server didn't answer in time"), { code: "ETIMEDOUT" })), timeoutMs);
    });
    await Promise.race([client.connect(), timeout]);
    const gmail = client.capabilities.has("X-GM-EXT-1");
    await Promise.race([client.logout(), timeout]).catch(() => client.close());
    return { gmail };
  } catch (error) {
    client.close();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Gmail / Google Workspace, from the address and the server. */
export function looksLikeGoogle(provider: Provider, host: string): boolean {
  return provider === "gmail" || /(^|\.)(gmail|googlemail)\.com$/i.test(host);
}
