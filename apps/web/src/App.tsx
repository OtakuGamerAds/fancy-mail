/**
 * The window: Sidebar | Thread list | Reader (or Settings / Activity in place of the last
 * two), the overlays (palette, compose, dialogs, the Activity sheet) and the toasts.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ActivityPage, ActivitySheet } from "~/components/activity/Activity";
import { AddAccountDialog } from "~/components/accounts/AddAccountDialog";
import { CommandPalette } from "~/components/CommandPalette";
import { ComposeDialog } from "~/components/compose/ComposeDialog";
import { ConnectionPill } from "~/components/ConnectionPill";
import { ConfirmDialogs } from "~/components/dialogs/ConfirmDialogs";
import { LabelPickerDialog } from "~/components/LabelPicker";
import { ThreadList } from "~/components/list/ThreadList";
import { NoConversation, Reader } from "~/components/reader/Reader";
import { SettingsView } from "~/components/settings/SettingsView";
import { ShortcutsDialog } from "~/components/ShortcutsDialog";
import { Sidebar } from "~/components/sidebar/Sidebar";
import { Spinner } from "~/components/ui/spinner";
import { Toaster } from "~/components/ui/toast";
import { TooltipProvider } from "~/components/ui/tooltip";
import { useColumnResize } from "~/hooks/useColumnResize";
import { useKeyboard } from "~/hooks/useKeyboard";
import { bridge } from "~/lib/desktop";
import { useDelayed } from "~/hooks/useDelayed";
import { useElementWidth } from "~/hooks/useElementWidth";
import { noteAgentActivity } from "~/state/events";
import { queryClient, useActivity, useBootstrap } from "~/state/queries";
import { navigateBackTo, onRouteChange, startRouter, type ViewRef } from "~/state/router";
import { LIST_DEFAULT, LIST_MAX, LIST_MIN, useUi } from "~/state/ui";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={500}>
        <Shell />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function useRouterSync() {
  useEffect(() => {
    const off = onRouteChange((route, overlays) => {
      const ui = useUi.getState();
      ui.setRoute(route);
      if (overlays.palette) ui.openPalette();
      if (overlays.compose === "new") ui.openCompose();
      if (overlays.dialog) ui.openDialog({ type: overlays.dialog });
    });
    startRouter();
    return off;
  }, []);
}

/** The footer's dot: the newest agent change in the first Activity page. */
function useAgentActivityDot() {
  const activity = useActivity();
  const first = activity.data?.pages[0]?.items;
  useEffect(() => {
    const latest = first?.find((a) => a.actor.kind === "agent");
    if (latest) noteAgentActivity(latest.at);
  }, [first]);
}

/** The desktop shell learns the tray setting from here (it may start before the server). */
function useTraySetting() {
  const closeToTray = useBootstrap().data?.settings.closeToTray;
  useEffect(() => {
    if (closeToTray !== undefined) bridge()?.setCloseToTray(closeToTray);
  }, [closeToTray]);
}

/** The window title carries the unread inbox count (taskbar, alt-tab). */
function useWindowTitle() {
  const accounts = useBootstrap().data?.accounts;
  const unread = accounts?.reduce((sum, a) => sum + a.unreadInboxCount, 0) ?? 0;
  useEffect(() => {
    document.title = unread > 0 ? `Fancy Mail (${unread > 999 ? "999+" : unread})` : "Fancy Mail";
  }, [unread]);
}

function Shell() {
  useRouterSync();
  useTraySetting();
  useWindowTitle();
  useKeyboard();
  useAgentActivityDot();
  const bootstrap = useBootstrap();
  const route = useUi((s) => s.route);
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);
  const showSplash = useDelayed(bootstrap.isPending, 400);

  if (bootstrap.isPending) {
    return (
      <div className="flex h-full flex-col">
        <div data-drag-region className="app-drag h-10 shrink-0" />
        <div className="grid flex-1 place-items-center pb-10">
          {showSplash ? (
            <div className="flex items-center gap-2.5 text-muted-foreground text-sm">
              <Spinner size="sm" tone="muted" />
              Starting Fancy Mail…
            </div>
          ) : null}
        </div>
        <ConnectionPill />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      {!sidebarCollapsed ? <Sidebar /> : null}
      <main className="relative flex min-w-0 flex-1">
        {route.page === "mail" ? (
          <MailView view={route.view} threadId={route.threadId} />
        ) : route.page === "settings" ? (
          <SettingsView section={route.section} />
        ) : (
          <ActivityPage />
        )}
      </main>
      <CommandPalette />
      <ComposeDialog />
      <AddAccountDialog />
      <ShortcutsDialog />
      <ConfirmDialogs />
      <LabelPickerDialog />
      <ActivitySheet />
      <ConnectionPill />
    </div>
  );
}

/** The reader never gets narrower than this beside the list; below it, one column. */
const READER_MIN = 440;

function MailView({ view, threadId }: { view: ViewRef; threadId: string | null }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(boxRef);
  const { data: bootstrap } = useBootstrap();
  const readingPane = bootstrap?.settings.readingPane ?? "right";
  const listWidth = useUi((s) => s.listWidth);
  const setListWidth = useUi((s) => s.setListWidth);
  const resize = useColumnResize({
    width: Math.max(LIST_MIN, Math.min(listWidth, width - READER_MIN)),
    min: LIST_MIN,
    max: Math.max(LIST_MIN, Math.min(LIST_MAX, width - READER_MIN)),
    onChange: setListWidth,
    defaultWidth: LIST_DEFAULT,
  });

  const close = () => {
    const ui = useUi.getState();
    if (threadId) ui.setFocusedThread(threadId);
    navigateBackTo({ page: "mail", view, threadId: null });
  };

  const twoColumns = readingPane === "right" && width >= LIST_MIN + READER_MIN;
  const shownListWidth = Math.max(LIST_MIN, Math.min(listWidth, width - READER_MIN));

  // One element in both layouts, so the width keeps being measured when it switches.
  return (
    <div ref={boxRef} className="flex h-full min-w-0 flex-1">
      {twoColumns ? (
        <>
          <div className="relative h-full shrink-0 border-border border-r" style={{ width: shownListWidth }}>
            <ThreadList view={view} rightmost={false} />
            <div {...resize.handleProps} style={{ left: "100%" }} aria-label="Resize the list" />
          </div>
          <div className="h-full min-w-0 flex-1">
            {threadId ? <Reader key={threadId} threadId={threadId} onClose={close} fullWidth={false} /> : <NoConversation />}
          </div>
        </>
      ) : (
        // One column: the list, or the open conversation in its place.
        <div className="min-w-0 flex-1">
          {threadId ? <Reader key={threadId} threadId={threadId} onClose={close} fullWidth /> : <ThreadList view={view} rightmost />}
        </div>
      )}
    </div>
  );
}
