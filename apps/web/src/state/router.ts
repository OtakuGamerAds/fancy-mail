/**
 * Hash routing. The address is the source of truth; the ui store mirrors it, so back and
 * forward (and the mouse's back/forward buttons) move between views and conversations.
 *
 *   #/inbox  #/unread … #/trash               a view across every account
 *   #/g/<groupId>/<kind>  #/a/<accountId>/<kind>
 *   #/a/<accountId>/folder/<mailboxId>
 *   #/label/<labelId>  (+ a scope prefix)      #/search?q=…  (+ a scope prefix)
 *   any of these + /t/<threadId>               an open conversation
 *   #/settings/<section>  #/activity
 *   ?palette=1 ?compose=new ?dialog=add-account ?dialog=shortcuts   overlays
 */
import {
  VIEW_KINDS,
  type Bootstrap,
  type MailView,
  type ViewKind,
  type ViewScope,
} from "@fancy-mail/contracts";

export const SETTINGS_SECTIONS = [
  "accounts",
  "groups-labels",
  "agents",
  "reading",
  "sign-in",
  "data",
  "about",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type ViewRef =
  | { kind: ViewKind; scope: ViewScope }
  | { kind: "label"; labelId: string; scope: ViewScope }
  | { kind: "mailbox"; accountId: string; mailboxId: string }
  | { kind: "search"; query: string; scope: ViewScope };

export type Route =
  | { page: "mail"; view: ViewRef; threadId: string | null }
  | { page: "settings"; section: SettingsSection }
  | { page: "activity" };

export interface Overlays {
  palette?: boolean;
  compose?: "new";
  dialog?: "add-account" | "shortcuts";
}

export const INBOX_ROUTE: Route = { page: "mail", view: { kind: "inbox", scope: { type: "all" } }, threadId: null };

const enc = encodeURIComponent;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseHash(hash: string): { route: Route; overlays: Overlays; valid: boolean } {
  const raw = hash.replace(/^#/, "");
  const queryIndex = raw.indexOf("?");
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : raw.slice(queryIndex + 1));
  const overlays: Overlays = {};
  if (params.get("palette") === "1") overlays.palette = true;
  if (params.get("compose") === "new") overlays.compose = "new";
  const dialog = params.get("dialog");
  if (dialog === "add-account" || dialog === "shortcuts") overlays.dialog = dialog;

  const segments = path.split("/").filter(Boolean).map(safeDecode);
  const invalid = { route: INBOX_ROUTE, overlays, valid: false };
  if (segments.length === 0) return invalid;

  if (segments[0] === "settings") {
    const section = (segments[1] ?? "accounts") as SettingsSection;
    if (!SETTINGS_SECTIONS.includes(section)) return { route: { page: "settings", section: "accounts" }, overlays, valid: false };
    return { route: { page: "settings", section }, overlays, valid: true };
  }
  if (segments[0] === "activity") return { route: { page: "activity" }, overlays, valid: segments.length === 1 };

  let scope: ViewScope = { type: "all" };
  let rest = segments;
  if ((segments[0] === "g" || segments[0] === "a") && segments[1]) {
    scope = segments[0] === "g" ? { type: "group", groupId: segments[1] } : { type: "account", accountId: segments[1] };
    rest = segments.slice(2);
  }

  let view: ViewRef | null = null;
  const head = rest[0];
  if (head === undefined) {
    view = { kind: "inbox", scope };
  } else if ((VIEW_KINDS as readonly string[]).includes(head)) {
    view = { kind: head as ViewKind, scope };
    rest = rest.slice(1);
  } else if (head === "label" && rest[1]) {
    view = { kind: "label", labelId: rest[1], scope };
    rest = rest.slice(2);
  } else if (head === "folder" && rest[1] && scope.type === "account") {
    view = { kind: "mailbox", accountId: scope.accountId, mailboxId: rest[1] };
    rest = rest.slice(2);
  } else if (head === "search") {
    view = { kind: "search", query: params.get("q") ?? "", scope };
    rest = rest.slice(1);
  }
  if (!view) return invalid;

  let threadId: string | null = null;
  if (rest[0] === "t" && rest[1]) {
    threadId = rest[1];
    rest = rest.slice(2);
  }
  if (rest.length > 0) return invalid;
  return { route: { page: "mail", view, threadId }, overlays, valid: true };
}

function scopePrefix(scope: ViewScope): string {
  if (scope.type === "group") return `/g/${enc(scope.groupId)}`;
  if (scope.type === "account") return `/a/${enc(scope.accountId)}`;
  return "";
}

export function formatView(view: ViewRef): { path: string; query: string } {
  switch (view.kind) {
    case "label":
      return { path: `${scopePrefix(view.scope)}/label/${enc(view.labelId)}`, query: "" };
    case "mailbox":
      return { path: `/a/${enc(view.accountId)}/folder/${enc(view.mailboxId)}`, query: "" };
    case "search":
      return { path: `${scopePrefix(view.scope)}/search`, query: view.query ? `q=${enc(view.query)}` : "" };
    default:
      return { path: `${scopePrefix(view.scope)}/${view.kind}`, query: "" };
  }
}

export function formatRoute(route: Route): string {
  if (route.page === "settings") return `#/settings/${route.section}`;
  if (route.page === "activity") return "#/activity";
  const { path, query } = formatView(route.view);
  const thread = route.threadId ? `/t/${enc(route.threadId)}` : "";
  return `#${path}${thread}${query ? `?${query}` : ""}`;
}

export function sameViewRef(a: ViewRef, b: ViewRef): boolean {
  return formatView(a).path === formatView(b).path && formatView(a).query === formatView(b).query;
}

export function viewKey(view: ViewRef): string {
  const { path, query } = formatView(view);
  return query ? `${path}?${query}` : path;
}

/** The contracts' MailView for a route's view (a folder needs its path from bootstrap). */
export function toMailView(view: ViewRef, bootstrap: Bootstrap | undefined): MailView | null {
  if (view.kind === "mailbox") {
    const mailbox = bootstrap?.mailboxes.find((m) => m.id === view.mailboxId);
    if (!mailbox) return null;
    return { kind: "mailbox", accountId: view.accountId, mailboxId: view.mailboxId, path: mailbox.path };
  }
  return view;
}

export function viewScope(view: ViewRef): ViewScope {
  if (view.kind === "mailbox") return { type: "account", accountId: view.accountId };
  return view.scope;
}

// ── Navigation ──────────────────────────────────────────────────────────────────────────────

type Listener = (route: Route, overlays: Overlays) => void;
const listeners = new Set<Listener>();

export function onRouteChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  const { route, overlays, valid } = parseHash(window.location.hash);
  const hasOverlays = Object.keys(overlays).length > 0;
  // Overlay params open something once; the address then shows the route alone.
  if (!valid || hasOverlays) {
    window.history.replaceState(window.history.state, "", formatRoute(route));
  }
  for (const listener of listeners) listener(route, overlays);
}

export function startRouter(): void {
  window.addEventListener("hashchange", emit);
  window.addEventListener("popstate", emit);
  // The mouse's back and forward buttons. Chrome would also navigate on its own; preventing
  // the default keeps it to one step.
  window.addEventListener("mouseup", (event) => {
    if (event.button === 3) {
      event.preventDefault();
      window.history.back();
    } else if (event.button === 4) {
      event.preventDefault();
      window.history.forward();
    }
  });
  emit();
}

export function navigate(route: Route, options?: { replace?: boolean }): void {
  const target = formatRoute(route);
  if (target === window.location.hash) return;
  if (options?.replace) {
    window.history.replaceState(window.history.state, "", target);
  } else {
    window.history.pushState({ fmBack: window.location.hash }, "", target);
  }
  emit();
}

/** Back to `route` the way the person came: a history step when that is where they came from. */
export function navigateBackTo(route: Route): void {
  const target = formatRoute(route);
  const state = window.history.state as { fmBack?: string } | null;
  if (state?.fmBack === target) {
    window.history.back();
    return;
  }
  navigate(route, { replace: true });
}

export function currentRoute(): Route {
  return parseHash(window.location.hash).route;
}
