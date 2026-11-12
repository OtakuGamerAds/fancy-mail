/**
 * What the server pushes, turned into cache refreshes and notices: `invalidate` refetches what
 * it names, account status and MCP clients are patched in place, agent activity shows a toast
 * with Undo, and sign-in / sending results reach whoever waits for them.
 */
import type { Activity, Bootstrap, ServerEvent } from "@fancy-mail/contracts";
import { create } from "zustand";

import { toast } from "~/components/ui/toast";
import { actorLabel } from "~/lib/agents";
import { bridge } from "~/lib/desktop";
import { plural } from "~/lib/utils";
import { rpcClient, type ConnectionStatus } from "~/rpc/client";
import { showActivityToast } from "./actions";
import { qk, queryClient } from "./queries";
import { navigate, type Route } from "./router";
import { useUi } from "./ui";

// ── Connection and agent state the UI shows ─────────────────────────────────────────────────

interface LiveState {
  connection: ConnectionStatus;
  /** Newest agent change seen in this session or the first Activity page. */
  latestAgentActivityAt: number;
}

export const useLive = create<LiveState>()(() => ({
  connection: rpcClient.status,
  latestAgentActivityAt: 0,
}));

export function noteAgentActivity(at: number) {
  if (at > useLive.getState().latestAgentActivityAt) useLive.setState({ latestAgentActivityAt: at });
}

// ── Waiters (sign-in flows, sending) ────────────────────────────────────────────────────────

type OAuthResult = Extract<ServerEvent, { type: "oauthFinished" }>;
const oauthListeners = new Set<(event: OAuthResult) => void>();

export function onOAuthFinished(listener: (event: OAuthResult) => void): () => void {
  oauthListeners.add(listener);
  return () => oauthListeners.delete(listener);
}

// ── Handling events ─────────────────────────────────────────────────────────────────────────

function patchBootstrap(update: (b: Bootstrap) => Bootstrap) {
  const current = queryClient.getQueryData<Bootstrap>(qk.bootstrap);
  if (current) queryClient.setQueryData<Bootstrap>(qk.bootstrap, update(current));
}

function searchRoute(threadIds: string[]): Route {
  return {
    page: "mail",
    view: { kind: "search", query: threadIds.map((id) => `thread:${id}`).join(" "), scope: { type: "all" } },
    threadId: threadIds.length === 1 ? threadIds[0]! : null,
  };
}

export function showThreadsOf(activity: Activity) {
  if (activity.threadIds.length === 0) {
    navigate({ page: "activity" });
    return;
  }
  navigate(searchRoute(activity.threadIds.slice(0, 50)));
}

function handle(event: ServerEvent) {
  switch (event.type) {
    case "invalidate": {
      const topics = new Set(event.topics);
      if (["accounts", "groups", "labels", "mailboxes", "settings", "mcp"].some((t) => topics.has(t as never))) {
        void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      }
      if (topics.has("threads")) {
        void queryClient.invalidateQueries({ queryKey: qk.threadsAll });
        void queryClient.invalidateQueries({ queryKey: ["quick-search"] });
        void queryClient.invalidateQueries({ queryKey: qk.facetsAll });
        void queryClient.invalidateQueries({ queryKey: qk.threadStates });
        // Counts in the sidebar come with bootstrap.
        void queryClient.invalidateQueries({ queryKey: qk.bootstrap });
      }
      if (topics.has("threads") || topics.has("drafts")) {
        if (event.threadIds?.length) {
          for (const id of event.threadIds) void queryClient.invalidateQueries({ queryKey: qk.thread(id) });
        } else {
          void queryClient.invalidateQueries({ queryKey: qk.threadAll });
        }
      }
      if (topics.has("drafts")) {
        void queryClient.invalidateQueries({ queryKey: qk.drafts });
        if (!topics.has("threads")) void queryClient.invalidateQueries({ queryKey: qk.threadsAll });
      }
      if (topics.has("activity")) void queryClient.invalidateQueries({ queryKey: qk.activity });
      break;
    }
    case "accountStatus":
      patchBootstrap((b) => ({
        ...b,
        accounts: b.accounts.map((a) => (a.id === event.accountId ? { ...a, status: event.status } : a)),
      }));
      break;
    case "mcpClients":
      patchBootstrap((b) => ({ ...b, mcp: { ...b.mcp, clients: event.clients } }));
      break;
    case "activity": {
      void queryClient.invalidateQueries({ queryKey: qk.activity });
      const { activity } = event;
      if (activity.actor.kind === "agent") {
        noteAgentActivity(activity.at);
        showActivityToast(activity, {
          title: `${actorLabel(activity.actor)} ${lowerFirst(activity.summary)}`,
          onShow: () => showThreadsOf(activity),
        });
        if (activity.undoable) useUi.getState().pushUndo(activity.id);
      }
      break;
    }
    case "oauthFinished":
      for (const listener of oauthListeners) listener(event);
      break;
    case "draftSent":
      void queryClient.invalidateQueries({ queryKey: qk.drafts });
      if (event.ok) toast.show({ id: `send-${event.draftId}`, type: "success", title: "Sent", duration: 3500 });
      else
        toast.show({
          id: `send-${event.draftId}`,
          type: "error",
          title: "Couldn't send your message",
          description: `${event.error ?? "The mail server refused it."} It's saved in Drafts.`,
          duration: 0,
          actions: [
            {
              label: "Open Drafts",
              onClick: () => navigate({ page: "mail", view: { kind: "drafts", scope: { type: "all" } }, threadId: null }),
            },
          ],
        });
      break;
    case "newMail": {
      const desktop = bridge();
      const boot = queryClient.getQueryData<Bootstrap>(qk.bootstrap);
      if (!desktop || document.hasFocus() || !boot?.settings.notifications) break;
      const account = boot.accounts.find((a) => a.id === event.accountId);
      desktop.notify({
        title: event.count === 1 ? "New message" : `${plural(event.count, "new message")}`,
        body: account ? account.email : "Fancy Mail",
        ...(event.threadIds.length === 1 ? { threadId: event.threadIds[0]! } : {}),
      });
      break;
    }
  }
}

function lowerFirst(text: string): string {
  // "Labeled 12 conversations Invoices" → "labeled 12 conversations Invoices" after the name.
  if (/^[A-Z][a-z]/.test(text)) return text[0]!.toLowerCase() + text.slice(1);
  return text;
}

let started = false;

export function startEvents() {
  if (started) return;
  started = true;
  rpcClient.onEvent(handle);
  rpcClient.onStatus(() => useLive.setState({ connection: rpcClient.status }));
  rpcClient.onReconnect(() => {
    // Anything may have changed while the socket was down.
    void queryClient.invalidateQueries();
  });
  bridge()?.onOpenThread((threadId) => {
    const route = useUi.getState().route;
    const view = route.page === "mail" ? route.view : { kind: "inbox" as const, scope: { type: "all" as const } };
    navigate({ page: "mail", view, threadId });
  });
}
