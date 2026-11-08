/**
 * Known mail providers: their servers and the way to sign in. Used by the "Add account" form
 * to fill everything in from the address alone.
 */
import type { AuthKind, Provider, ServerEndpoint } from "./domain.ts";

export interface ProviderPreset {
  id: string;
  name: string;
  provider: Provider;
  domains: readonly string[];
  imap: ServerEndpoint;
  smtp: ServerEndpoint;
  /** In the order the form offers them; the first is the recommended one. */
  auth: readonly AuthKind[];
  /** Where to create an app password, when the provider needs one for IMAP. */
  appPasswordUrl: string | null;
  /** One sentence shown above the password field. */
  passwordHint: string | null;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "gmail",
    name: "Gmail",
    provider: "gmail",
    domains: ["gmail.com", "googlemail.com"],
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    auth: ["password", "oauth-google"],
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    passwordHint:
      "Use an app password, not your Google password. It needs 2-Step Verification, works until you change your Google password, and never expires on its own.",
  },
  {
    id: "outlook",
    name: "Outlook",
    provider: "outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.de", "hotmail.de"],
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
    auth: ["oauth-microsoft"],
    appPasswordUrl: null,
    passwordHint: "Outlook.com only allows signing in with Microsoft.",
  },
  {
    id: "yahoo",
    name: "Yahoo",
    provider: "imap",
    domains: ["yahoo.com", "yahoo.de", "ymail.com"],
    imap: { host: "imap.mail.yahoo.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.yahoo.com", port: 465, secure: true },
    auth: ["password"],
    appPasswordUrl: "https://login.yahoo.com/account/security",
    passwordHint: "Use an app password from Yahoo's account security page.",
  },
  {
    id: "icloud",
    name: "iCloud",
    provider: "imap",
    domains: ["icloud.com", "me.com", "mac.com"],
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    auth: ["password"],
    appPasswordUrl: "https://account.apple.com/account/manage",
    passwordHint: "Use an app-specific password from your Apple Account.",
  },
  {
    id: "gmx",
    name: "GMX",
    provider: "imap",
    domains: ["gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com"],
    imap: { host: "imap.gmx.net", port: 993, secure: true },
    smtp: { host: "mail.gmx.net", port: 465, secure: true },
    auth: ["password"],
    appPasswordUrl: null,
    passwordHint: "Turn on IMAP access in GMX's settings first.",
  },
  {
    id: "webde",
    name: "WEB.DE",
    provider: "imap",
    domains: ["web.de"],
    imap: { host: "imap.web.de", port: 993, secure: true },
    smtp: { host: "smtp.web.de", port: 587, secure: false },
    auth: ["password"],
    appPasswordUrl: null,
    passwordHint: "Turn on IMAP access in WEB.DE's settings first.",
  },
  {
    id: "tonline",
    name: "Telekom",
    provider: "imap",
    domains: ["t-online.de"],
    imap: { host: "secureimap.t-online.de", port: 993, secure: true },
    smtp: { host: "securesmtp.t-online.de", port: 465, secure: true },
    auth: ["password"],
    appPasswordUrl: null,
    passwordHint: "Use the mail password (Passwort für E-Mail-Programme) from the Telekom Kundencenter.",
  },
];

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

/** The preset for an address, or null for a custom server (Google Workspace domains included). */
export function presetForEmail(email: string): ProviderPreset | null {
  const domain = domainOf(email);
  return PROVIDER_PRESETS.find((p) => p.domains.includes(domain)) ?? null;
}

export const GMAIL_PRESET = PROVIDER_PRESETS[0]!;
