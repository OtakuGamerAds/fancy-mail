/**
 * The window: Sidebar | Thread list | Reader or a new message (or Settings / Activity in
 * place of the last two), the overlays (palette, dialogs, the Activity sheet) and the toasts.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ActivityPage, ActivitySheet } from "~/components/activity/Activity";
import { AddAccountDialog } from "~/components/accounts/AddAccountDialog";
import { CommandPalette } from "~/components/CommandPalette";
import { ComposePane } from "~/components/compose/ComposePane";
import { ConnectionPill } from "~/components/ConnectionPill";
import { ConfirmDialogs } from "~/components/dialogs/ConfirmDialogs";
import { CustomTimeDialogHost } from "~/components/StateMenus";
import { LabelPickerDialog } from "~/components/LabelPicker";
import { ThreadList } from "~/components/list/ThreadList";
import { Reader } from "~/components/reader/Reader";
import { SettingsView } from "~/components/settings/SettingsView";
import { ShortcutsDialog } from "~/components/ShortcutsDialog";
import { Sidebar } from "~/components/sidebar/Sidebar";
import { checkForUpdatesFromMenu, useUpdateNotices } from "~/components/sidebar/UpdateButton";
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
import { navigate, navigateBackTo, onRouteChange, startRouter, type ViewRef } from "~/state/router";
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
      if (overlays.search !== undefined) ui.setSearch(overlays.search);
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

/** The macOS app menu's items the page carries out ("Settings…", "Check for Updates…"). */
function useMenuActions() {
  useEffect(() => {
    const off = bridge()?.onMenuAction?.((action) => {
      if (action === "settings") navigate({ page: "settings", section: "accounts" });
      else if (action === "check-for-updates") checkForUpdatesFromMenu();
    });
    return typeof off === "function" ? off : undefined;
  }, []);
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
  useMenuActions();
  useWindowTitle();
  useKeyboard();
  useAgentActivityDot();
  useUpdateNotices();
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
      <AddAccountDialog />
      <ShortcutsDialog />
      <ConfirmDialogs />
      <CustomTimeDialogHost />
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
  const compose = useUi((s) => s.compose);
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

  // The reader column is there only while a conversation or a new message is open; otherwise
  // the list takes the whole width.
  const pane = compose ? (
    <ComposePane compose={compose} fullWidth={false} />
  ) : threadId ? (
    <Reader key={threadId} threadId={threadId} onClose={close} fullWidth={false} />
  ) : null;
  const fits = readingPane === "right" && width >= LIST_MIN + READER_MIN;
  const twoColumns = fits && pane !== null;
  const shownListWidth = Math.max(LIST_MIN, Math.min(listWidth, width - READER_MIN));

  // The list stays in the same place in the tree in every layout, so opening or closing a
  // conversation doesn't remount it (and lose its scroll position). The width keeps being
  // measured on the outer element.
  return (
    <div ref={boxRef} className="flex h-full min-w-0 flex-1">
      {twoColumns || pane === null ? (
        <div
          className={twoColumns ? "relative h-full shrink-0 border-border border-r" : "h-full min-w-0 flex-1"}
          style={twoColumns ? { width: shownListWidth } : undefined}
        >
          <ThreadList view={view} rightmost={!twoColumns} />
          {twoColumns ? <div {...resize.handleProps} style={{ left: "100%" }} aria-label="Resize the list" /> : null}
        </div>
      ) : null}
      {pane !== null ? (
        <div className="h-full min-w-0 flex-1">
          {twoColumns ? pane : compose ? <ComposePane compose={compose} fullWidth /> : <Reader key={threadId} threadId={threadId!} onClose={close} fullWidth />}
        </div>
      ) : null}
    </div>
  );
}
