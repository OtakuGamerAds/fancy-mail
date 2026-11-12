/**
 * The conversation list: a header strip (title, scope, count, sync, select all — or the bulk
 * bar while rows are checked), the filter chips with the search that narrows it (typed in the
 * sidebar), and the virtualized rows. New messages still being written sit at the top of
 * their inbox. When the view or the search changes, the new rows slide in.
 *
 * Where conversations stand shapes the list, as T3 Code's sidebar: pinned ones on top, then
 * what's your turn, then the sections of what's out of the way — Waiting (for an answer),
 * Snoozed, Settled. Their headers stay at the foot of the pane with their counts; opened, their
 * conversations follow, dimmed, each section a list of its own. Searching shows everything in
 * place.
 */
import { scopeQuery, type Draft, type InboxTab, type ThreadSummary } from "@fancy-mail/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  AlarmClockIcon,
  AlarmClockOffIcon,
  CircleCheckIcon,
  HourglassIcon,
  InboxIcon,
  PinIcon,
  PinOffIcon,
  TimerOffIcon,
  InfoIcon,
  MailIcon,
  MailOpenIcon,
  MailPlusIcon,
  MessagesSquareIcon,
  OctagonAlertIcon,
  SearchIcon,
  SearchXIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  Undo2Icon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { IconButton, ShowSidebarButton } from "~/components/common";
import { LabelPickerContent, LabelPickerPopover } from "~/components/LabelPicker";
import { DemoBanner } from "~/components/list/DemoBanner";
import { TIMED_COPY, TimeMenuItems } from "~/components/StateMenus";
import { ROW_HEIGHT, ThreadRow } from "~/components/list/ThreadRow";
import { useRowMenu } from "~/components/sidebar/EntityMenus";
import { Button } from "~/components/ui/button";
import { CheckboxMark } from "~/components/ui/checkbox";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { useDebounced } from "~/hooks/useDebounced";
import { formatCount } from "~/lib/format";
import { splitDraftBody } from "~/lib/plainText";
import { cn, plural, safeStorage } from "~/lib/utils";
import { errorMessage } from "~/rpc/client";
import {
  archiveOrInbox,
  runThreadCommand,
  runTimedCommand,
  spamOrNot,
  threadState,
  toggleRead,
  toggleSettle,
  toggleStar,
  trashOrRestore,
  type ThreadState,
} from "~/state/commands";
import { listNav } from "~/state/listNav";
import { openConversation } from "~/state/openConversation";
import { useBootstrap, useDirectory, useDrafts, useSearchFacets, useThreads, useThreadStates } from "~/state/queries";
import { currentRoute, navigateBackTo, viewKey, type ViewRef } from "~/state/router";
import { useUi, type InboxTabId, type ListFilter } from "~/state/ui";
import { goScope } from "~/state/scope";
import { describeView, FILTER_QUERY, inboxTabQuery, inScope, listQuery, searchWidens, splitsSettled } from "~/state/view";

const FILTERS: { id: ListFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "starred", label: "Starred" },
  { id: "attachments", label: "Attachments" },
];

const INBOX_TABS: Record<InboxTabId, { label: string; icon: LucideIcon }> = {
  primary: { label: "Primary", icon: InboxIcon },
  promotions: { label: "Promotions", icon: TagIcon },
  social: { label: "Social", icon: UsersIcon },
  updates: { label: "Updates", icon: InfoIcon },
  forums: { label: "Forums", icon: MessagesSquareIcon },
};

const EXAMPLES = ["from:anna has:attachment", "is:unread newer_than:7d"];

/** Which sections are open (remembered, as T3 Code remembers its shelves). */
const SHELVES_OPEN_KEY = "fancy-mail:list:shelves-open";
/** A section header's height (they stack at the foot of the pane). */
const SHELF_HEADER_HEIGHT = 36;

type ShelfKey = "waiting" | "snoozed" | "settled";
const SHELVES: { key: ShelfKey; label: string }[] = [
  { key: "waiting", label: "Waiting" },
  { key: "snoozed", label: "Snoozed" },
  { key: "settled", label: "Settled" },
];

/** A section's count, and its conversations while it's open. */
function useShelf(query: string | null, open: boolean) {
  const facets = useSearchFacets(query ?? "");
  const list = useThreads(query && open ? query : null);
  const threads = useMemo(() => (query && open ? (list.data?.pages.flatMap((p) => p.threads) ?? []) : []), [query, open, list.data]);
  return {
    total: query ? (facets.data?.total ?? 0) : 0,
    threads,
    hasNextPage: !!(query && open && list.hasNextPage),
    isFetchingNextPage: list.isFetchingNextPage,
    fetchNextPage: list.fetchNextPage,
  };
}

/** How long rows that arrive after a change keep their entrance (rows scrolled into view later don't). */
const ENTER_WINDOW_MS = 450;

/** An unsent new message, as a row (it has no conversation of its own yet). */
function draftRow(draft: Draft): ThreadSummary {
  const text = splitDraftBody(draft.bodyText).text.replace(/\s+/g, " ").trim();
  return {
    id: draft.conversationId,
    accountId: draft.accountId,
    subject: draft.subject,
    snippet: text.slice(0, 200),
    participants: [...draft.to, ...draft.cc],
    lastMessageAt: draft.updatedAt,
    messageCount: 0,
    unreadCount: 0,
    starred: false,
    hasAttachments: draft.attachments.length > 0,
    labelIds: [],
    inInbox: false,
    inSent: false,
    inTrash: false,
    inSpam: false,
    draftCount: 1,
    category: null,
  };
}

export function ThreadList({ view, rightmost }: { view: ViewRef; rightmost: boolean }) {
  const { data: bootstrap } = useBootstrap();
  const dir = useDirectory();
  const info = describeView(view, bootstrap);
  const density = bootstrap?.settings.density ?? "comfortable";

  const routeThreadId = useUi((s) => (s.route.page === "mail" ? s.route.threadId : null));
  const composeThreadId = useUi((s) => s.compose?.threadId ?? null);
  const openThreadId = routeThreadId ?? composeThreadId;
  const focusedThreadId = useUi((s) => s.focusedThreadId);
  const selection = useUi((s) => s.selection);
  const filter = useUi((s) => s.listFilter);

  // ── The query: the view, the inbox tab, the sidebar's search, the filter chip ──
  const rawSearch = useUi((s) => s.search);
  const search = useDebounced(rawSearch, 150).trim();
  // Gmail's tabs, in an inbox with Gmail mail (a search looks through all of them).
  const shownTabs = bootstrap?.settings.inboxTabs ?? [];
  const hasTabs =
    view.kind === "inbox" && shownTabs.length > 0 && dir.accounts.some((a) => (a.provider === "gmail" || a.provider === "demo") && inScope(a.id, info.scope, dir));
  const storedTab = useUi((s) => s.inboxTab);
  const tab: InboxTabId = hasTabs && (storedTab === "primary" || shownTabs.includes(storedTab)) ? storedTab : "primary";
  const showTabs = hasTabs && !rawSearch.trim();
  const viewListQuery = listQuery(view, info, search, filter, hasTabs ? inboxTabQuery(tab, shownTabs) : "");
  const stateIds = dir.stateLabelIds;
  const split = viewListQuery !== null && Object.keys(stateIds).length > 0 && splitsSettled(view, rawSearch);
  // In the inbox, Waiting and Snoozed hold all of this scope's (a message you sent and wait on
  // isn't in the inbox); elsewhere, the view's own.
  const awayBase = view.kind === "inbox" ? [scopeQuery(info.scope), FILTER_QUERY[filter]].filter(Boolean).join(" ") : viewListQuery;
  const query = split ? `${viewListQuery} -is:pinned -is:settled -is:waiting -is:snoozed` : viewListQuery;
  const pinnedQuery = split && stateIds.pinned ? `${viewListQuery} is:pinned` : null;
  const shelfQuery: Record<ShelfKey, string | null> = {
    waiting: split && stateIds.waiting ? `${awayBase} is:waiting` : null,
    snoozed: split && stateIds.snoozed ? `${awayBase} is:snoozed` : null,
    settled: split && stateIds.settled ? `${viewListQuery} is:settled` : null,
  };
  const threadsQuery = useThreads(query);
  const pinnedThreadsQuery = useThreads(pinnedQuery);
  const pinnedThreads = useMemo(() => (pinnedQuery ? (pinnedThreadsQuery.data?.pages[0]?.threads ?? []) : []), [pinnedQuery, pinnedThreadsQuery.data]);
  const [openShelves, setOpenShelves] = useState<Record<ShelfKey, boolean>>(() => ({
    waiting: false,
    snoozed: false,
    settled: false,
    ...safeStorage.get<Partial<Record<ShelfKey, boolean>>>(SHELVES_OPEN_KEY, {}),
  }));
  const toggleShelf = (key: ShelfKey) =>
    setOpenShelves((open) => {
      const next = { ...open, [key]: !open[key] };
      safeStorage.set(SHELVES_OPEN_KEY, next);
      return next;
    });
  const shelfData = {
    waiting: useShelf(shelfQuery.waiting, openShelves.waiting),
    snoozed: useShelf(shelfQuery.snoozed, openShelves.snoozed),
    settled: useShelf(shelfQuery.settled, openShelves.settled),
  };
  const shelves = SHELVES.filter((shelf) => shelfData[shelf.key].total > 0 || shelfData[shelf.key].threads.length > 0);
  const states = useThreadStates();
  const fetched = useMemo(() => threadsQuery.data?.pages.flatMap((p) => p.threads) ?? [], [threadsQuery.data]);
  const firstPage = threadsQuery.data?.pages[0];
  const total = firstPage?.total ?? 0;
  const queryErrors = firstPage?.queryErrors ?? [];

  // New messages being written sit at the top of their inbox (not while searching or filtering).
  const drafts = useDrafts();
  const showDrafts = view.kind === "inbox" && tab === "primary" && !search && filter === "all";
  const threads = useMemo(() => {
    if (!showDrafts) return fetched;
    const pending = (drafts.data ?? [])
      .filter((d) => d.mode === "new" && (d.sendState === "draft" || d.sendState === "failed") && inScope(d.accountId, info.scope, dir))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(draftRow);
    if (pending.length === 0) return fetched;
    const ids = new Set(pending.map((t) => t.id));
    return [...pending, ...fetched.filter((t) => !ids.has(t.id))];
  }, [showDrafts, drafts.data, fetched, info.scope, dir]);

  // ── Entrance: when other rows arrive (another view, another search), they slide in ──
  const settledQuery = threadsQuery.data && !threadsQuery.isPlaceholderData ? query : null;
  const lastSettled = useRef<string | null>(null);
  const [entering, setEntering] = useState<{ key: string; until: number } | null>(null);
  useEffect(() => {
    if (settledQuery === null || settledQuery === lastSettled.current) return;
    lastSettled.current = settledQuery;
    setEntering({ key: settledQuery, until: performance.now() + ENTER_WINDOW_MS });
    const timer = setTimeout(() => setEntering(null), ENTER_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [settledQuery]);
  const animateRows = entering !== null && performance.now() < entering.until;

  // ── Virtual rows: pinned on top, the active conversations, then the sections' own lists ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[density];
  const caughtUp = split && shelves.length > 0 && threads.length === 0 && pinnedThreads.length === 0 && !threadsQuery.hasNextPage;
  // The active list starts below the pinned rows.
  const activeListRef = useRef<HTMLDivElement>(null);
  const [activeTop, setActiveTop] = useState(0);
  useLayoutEffect(() => {
    const top = activeListRef.current?.offsetTop ?? 0;
    if (top !== activeTop) setActiveTop(top);
  });
  const virtualizer = useVirtualizer({
    count: threads.length + (threadsQuery.hasNextPage ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    scrollMargin: activeTop,
    getItemKey: (index) => threads[index]?.id ?? "loader-active",
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const lastIndex = items[items.length - 1]?.index ?? 0;
  useEffect(() => {
    if (lastIndex >= threads.length - 15 && threadsQuery.hasNextPage && !threadsQuery.isFetchingNextPage) {
      void threadsQuery.fetchNextPage();
    }
  }, [lastIndex, threads.length, threadsQuery]);

  // What the keyboard walks through: the conversations shown, in order.
  const shownThreads = useMemo(
    () => [...pinnedThreads, ...threads, ...SHELVES.flatMap((shelf) => (openShelves[shelf.key] ? shelfData[shelf.key].threads : []))],
    [pinnedThreads, threads, openShelves, shelfData.waiting.threads, shelfData.snoozed.threads, shelfData.settled.threads],
  );

  // Back to the top when other rows arrive.
  useEffect(() => {
    if (settledQuery !== null) scrollRef.current?.scrollTo({ top: 0 });
  }, [settledQuery]);

  useEffect(() => {
    listNav.threads = shownThreads;
  }, [shownThreads]);
  useEffect(() => {
    listNav.scrollToIndex = (index) => {
      const inActive = index - pinnedThreads.length;
      if (inActive >= 0 && inActive < threads.length) {
        virtualizer.scrollToIndex(inActive, { align: "auto" });
        return;
      }
      // Pinned rows, and sections' rows (rendered around what's shown).
      const id = shownThreads[index]?.id;
      if (id) scrollRef.current?.querySelector(`[data-thread-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
    };
  }, [virtualizer, pinnedThreads.length, threads.length, shownThreads]);

  // ── Clicks ──
  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const selectionMode = selection.length > 0;

  const toggleCheck = useCallback(
    (event: ReactMouseEvent, thread: ThreadSummary) => {
      const ui = useUi.getState();
      if (event.shiftKey && ui.selectionAnchor) {
        const from = shownThreads.findIndex((t) => t.id === ui.selectionAnchor);
        const to = shownThreads.findIndex((t) => t.id === thread.id);
        if (from !== -1 && to !== -1) {
          const [a, b] = from < to ? [from, to] : [to, from];
          const range = shownThreads.slice(a, b + 1).map((t) => t.id);
          ui.setSelection([...new Set([...ui.selection, ...range])], ui.selectionAnchor);
          return;
        }
      }
      const has = ui.selection.includes(thread.id);
      ui.setSelection(has ? ui.selection.filter((id) => id !== thread.id) : [...ui.selection, thread.id], thread.id);
      ui.setFocusedThread(thread.id);
    },
    [shownThreads],
  );

  const onRowClick = useCallback(
    (event: ReactMouseEvent, thread: ThreadSummary) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        toggleCheck(event, thread);
        return;
      }
      const ui = useUi.getState();
      ui.setFocusZone("list");
      // Clicking the conversation that is open closes it (like its X).
      const route = currentRoute();
      if (route.page === "mail" && route.threadId === thread.id && !ui.compose) {
        ui.setFocusedThread(thread.id);
        navigateBackTo({ ...route, threadId: null });
        return;
      }
      openConversation(thread.id);
    },
    [toggleCheck],
  );

  const rowMenu = useRowMenu();
  const [menuThread, setMenuThread] = useState<ThreadSummary | null>(null);
  const onContextMenu = useCallback(
    (event: ReactMouseEvent, thread: ThreadSummary) => {
      setMenuThread(thread);
      rowMenu.openAtPointer(event);
    },
    [rowMenu],
  );
  const menuTargets = menuThread ? (selectionSet.has(menuThread.id) ? selection : [menuThread.id]) : [];

  // ── Header ──
  const allChecked = shownThreads.length > 0 && shownThreads.every((t) => selectionSet.has(t.id));
  const someChecked = selectionMode && !allChecked;
  const toggleAll = () => {
    const ui = useUi.getState();
    if (allChecked || someChecked) ui.clearSelection();
    else ui.setSelection(shownThreads.map((t) => t.id), shownThreads[0]?.id ?? null);
  };

  // Above the rows' checkboxes (same 0.5rem inset and 1.25rem cell as ThreadRow's).
  const checkAll = (
    <button
      type="button"
      role="checkbox"
      aria-checked={allChecked ? true : someChecked ? "mixed" : false}
      aria-label={allChecked || someChecked ? "Uncheck all" : "Check all"}
      title={allChecked || someChecked ? "Uncheck all" : "Check all loaded"}
      disabled={shownThreads.length === 0}
      onClick={toggleAll}
      className="grid w-5 shrink-0 cursor-pointer place-items-center self-stretch rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
    >
      {someChecked ? (
        <span className="grid size-4 place-items-center rounded-[.25rem] border border-primary bg-primary text-primary-foreground">
          <span className="h-0.5 w-2 rounded-full bg-current" />
        </span>
      ) : (
        <CheckboxMark checked={allChecked} />
      )}
    </button>
  );

  const hideLabelId = view.kind === "label" ? view.labelId : null;
  const isPending = threadsQuery.isPending && query !== null;
  const showEmpty = !isPending && !threadsQuery.isError && threads.length === 0 && pinnedThreads.length === 0 && shelves.length === 0;
  const actionableHere = view.kind !== "trash" && view.kind !== "spam";
  const actionable = (thread: ThreadSummary) => actionableHere && thread.messageCount > 0 && !thread.inTrash && !thread.inSpam;
  const renderRow = (thread: ThreadSummary) => (
    <ThreadRow
      thread={thread}
      dir={dir}
      density={density}
      open={thread.id === openThreadId}
      focused={thread.id === focusedThreadId}
      checked={selectionSet.has(thread.id)}
      selectionMode={selectionMode}
      showAccount={info.spansAccounts}
      hideLabelId={hideLabelId}
      state={threadState(thread, stateIds)}
      timer={states.timers.get(thread.id) ?? null}
      mark={states.marks.get(thread.id) ?? null}
      actionable={actionable(thread)}
      onRowClick={onRowClick}
      onToggleCheck={toggleCheck}
      onContextMenu={onContextMenu}
    />
  );
  const searching = search.length > 0 || filter !== "all" || view.kind === "search";
  const setSearch = useUi((s) => s.setSearch);
  const thisViewKey = viewKey(view);

  return (
    <section className="flex h-full min-w-0 flex-col bg-background" aria-label={info.title}>
      {/* Title strip (the window's title bar here) */}
      <div
        data-drag-region
        className="app-drag flex h-[var(--header-height)] shrink-0 items-center gap-1.5 ps-3"
        style={{ paddingInlineEnd: rightmost ? "max(0.75rem, calc(var(--wco-inset) + 0.5rem))" : "0.75rem" }}
      >
        {selectionMode ? (
          <BulkBar view={view} selection={selection} />
        ) : (
          <>
            <ShowSidebarButton />
            <div key={thisViewKey} className="flex min-w-0 flex-1 animate-fade-in items-baseline gap-2 ps-1">
              <h1 className="truncate font-semibold text-[15px] text-foreground tracking-tight" data-selectable>
                {info.title}
              </h1>
              {info.scopeLabel ? (
                <span className="app-no-drag inline-flex min-w-0 max-w-56 shrink items-center self-center rounded-md bg-primary/10 ps-1.5 text-foreground/80 text-xs">
                  <span className="truncate py-0.5" title={info.scopeLabel}>
                    {info.scopeLabel}
                  </span>
                  <button
                    type="button"
                    aria-label="Show all accounts"
                    title="Show all accounts"
                    className="ms-0.5 grid size-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-white/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => goScope({ type: "all" })}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ) : null}
              {firstPage && !threadsQuery.isPlaceholderData ? (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {total >= 10_000 ? "10,000+" : formatCount(total)}
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>

      {/* Filter chips, and the search that narrows this view */}
      <div className={cn("flex shrink-0 items-center gap-1 pb-2", showTabs ? "px-3" : "border-border border-b ps-2 pe-3")} role="tablist" aria-label="Filter">
        {showTabs ? null : <span className="me-1 flex h-6 items-stretch">{checkAll}</span>}
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => useUi.getState().setListFilter(f.id)}
            className={cn(
              "h-6 shrink-0 cursor-pointer rounded-full px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              filter === f.id
                ? "bg-white/[0.09] font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
        {rawSearch.trim() ? (
          <span
            className="ms-auto flex h-6 min-w-0 animate-fade-in items-center gap-1 rounded-full bg-primary/14 ps-2 pe-0.5 text-foreground text-xs"
            title={searchWidens(view) ? "Searching all mail here, archived included" : undefined}
          >
            <SearchIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate" dir="auto">
              {rawSearch.trim()}
            </span>
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setSearch("")}
              className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ) : null}
      </div>
      {showTabs && info.query !== null ? (
        <InboxTabs tabs={["primary", ...shownTabs]} shown={shownTabs} active={tab} viewQuery={info.query} leading={checkAll} />
      ) : null}
      {queryErrors.length > 0 && threads.length > 0 ? (
        <ul className="shrink-0 space-y-0.5 border-border border-b px-3 py-1.5 text-warning-foreground/90 text-xs">
          {queryErrors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      {bootstrap?.hasDemoData ? <DemoBanner /> : null}

      {/* Rows */}
      <div ref={scrollRef} role="listbox" aria-label="Conversations" className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none]">
        {bootstrap && dir.accounts.length === 0 ? (
          <Welcome />
        ) : isPending ? (
          <ListSkeleton density={density} />
        ) : threadsQuery.isError && threads.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>Couldn't load this view</EmptyTitle>
              <EmptyDescription>{errorMessage(threadsQuery.error)}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="sm" onClick={() => void threadsQuery.refetch()}>
              Try again
            </Button>
          </Empty>
        ) : showEmpty ? (
          view.kind === "inbox" && !searching ? (
            <Empty size="compact" className="h-full animate-fade-in">
              <EmptyHeader>
                <EmptyMedia>
                  <InboxIcon className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
                </EmptyMedia>
                <EmptyTitle className="mt-3 text-muted-foreground">All caught up</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty size="compact" className="h-full animate-fade-in">
              <EmptyHeader>
                <EmptyMedia>
                  <SearchXIcon className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
                </EmptyMedia>
                <EmptyTitle className="mt-3 text-muted-foreground">Nothing matches</EmptyTitle>
                {queryErrors.length > 0 ? (
                  <EmptyDescription className="text-warning-foreground/90">{queryErrors.join(" ")}</EmptyDescription>
                ) : null}
                <EmptyDescription className="mt-2">
                  Try{" "}
                  {EXAMPLES.map((example, i) => (
                    <span key={example}>
                      {i > 0 ? " or " : null}
                      <button
                        type="button"
                        className="cursor-pointer rounded bg-white/[0.06] px-1 font-mono text-foreground/85 text-xs hover:bg-white/10"
                        onClick={() => setSearch(example)}
                      >
                        {example}
                      </button>
                    </span>
                  ))}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )
        ) : (
          <div className="flex min-h-full flex-col">
            {pinnedThreads.map((thread) => (
              <div key={thread.id} className="shrink-0" style={{ height: rowHeight }}>
                {renderRow(thread)}
              </div>
            ))}
            <div
              ref={activeListRef}
              key={entering?.key ?? lastSettled.current ?? "rows"}
              className="shrink-0"
              style={{ height: virtualizer.getTotalSize(), position: "relative" }}
            >
              {items.map((item) => {
                const thread = threads[item.index];
                const position = item.index - (items[0]?.index ?? 0);
                return (
                  <div
                    key={item.key}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: rowHeight, transform: `translateY(${item.start - activeTop}px)` }}
                  >
                    {thread ? (
                      <div
                        className={cn("h-full", animateRows && "animate-enter")}
                        style={animateRows ? { animationDelay: `${Math.min(position, 14) * 14}ms` } : undefined}
                      >
                        {renderRow(thread)}
                      </div>
                    ) : (
                      <RowSkeleton density={density} />
                    )}
                  </div>
                );
              })}
            </div>
            {caughtUp ? (
              <div className="flex min-h-40 flex-1 animate-fade-in flex-col items-center justify-center gap-3 text-muted-foreground">
                <InboxIcon className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
                <span className="font-medium text-sm">All caught up</span>
              </div>
            ) : null}
            {shelves.map((shelf, index) => (
              <Shelf
                key={shelf.key}
                shelfKey={shelf.key}
                label={shelf.label}
                first={index === 0}
                stickyBottom={(shelves.length - 1 - index) * SHELF_HEADER_HEIGHT}
                open={openShelves[shelf.key]}
                onToggle={() => toggleShelf(shelf.key)}
                data={shelfData[shelf.key]}
                scrollRef={scrollRef}
                rowHeight={rowHeight}
                density={density}
                renderRow={renderRow}
              />
            ))}
          </div>
        )}
      </div>

      <Menu open={rowMenu.open} onOpenChange={rowMenu.setOpen} modal={false}>
        <MenuPopup anchor={rowMenu.anchor ?? undefined} align="start" className="w-56">
          {menuThread ? (
            <RowMenuItems
              thread={menuThread}
              targets={menuTargets}
              state={threadState(menuThread, stateIds)}
              actionable={actionable(menuThread)}
            />
          ) : null}
        </MenuPopup>
      </Menu>
    </section>
  );
}

/**
 * One section at the foot of the list (Waiting, Snoozed, Settled): its header sticks to the
 * bottom of the pane (stacked with the others) until the list reaches it; opened, its
 * conversations follow in a virtual list of their own.
 */
function Shelf({
  shelfKey,
  label,
  first,
  stickyBottom,
  open,
  onToggle,
  data,
  scrollRef,
  rowHeight,
  density,
  renderRow,
}: {
  shelfKey: ShelfKey;
  label: string;
  first: boolean;
  stickyBottom: number;
  open: boolean;
  onToggle(): void;
  data: ReturnType<typeof useShelf>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  rowHeight: number;
  density: "comfortable" | "compact";
  renderRow(thread: ThreadSummary): React.ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const at = listRef.current?.offsetTop ?? 0;
    if (at !== top) setTop(at);
  });
  const { threads, hasNextPage, isFetchingNextPage, fetchNextPage } = data;
  const virtualizer = useVirtualizer({
    count: open ? threads.length + (hasNextPage ? 1 : 0) : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    scrollMargin: top,
    getItemKey: (index) => threads[index]?.id ?? "loader",
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1]?.index ?? -1;
  useEffect(() => {
    if (last >= threads.length - 15 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [last, threads.length, hasNextPage, isFetchingNextPage, fetchNextPage]);
  return (
    <>
      <div
        data-section={shelfKey}
        className={cn(
          "sticky z-10 flex shrink-0 items-center bg-background px-1.5",
          // The first one keeps the group at the foot of a short list, with a fade above it.
          first &&
            "mt-auto before:pointer-events-none before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-gradient-to-t before:from-background before:to-transparent",
        )}
        style={{ bottom: stickyBottom, height: SHELF_HEADER_HEIGHT }}
      >
        <CollapsibleSectionHeader expanded={open} onClick={onToggle} accessory={<span className="font-normal tabular-nums">{formatCount(data.total)}</span>}>
          {label}
        </CollapsibleSectionHeader>
      </div>
      <div ref={listRef} className="shrink-0" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {items.map((item) => {
          const thread = threads[item.index];
          return (
            <div
              key={item.key}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", height: rowHeight, transform: `translateY(${item.start - top}px)` }}
            >
              {thread ? renderRow(thread) : <RowSkeleton density={density} />}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Gmail's inbox tabs. Each one says how many unread conversations it has. */
function InboxTabs({
  tabs,
  shown,
  active,
  viewQuery,
  leading,
}: {
  tabs: InboxTabId[];
  shown: InboxTab[];
  active: InboxTabId;
  viewQuery: string;
  leading: React.ReactNode;
}) {
  return (
    <div role="tablist" aria-label="Inbox tabs" className="flex shrink-0 items-stretch gap-0.5 border-border border-b px-2">
      <span className="me-1.5 flex">{leading}</span>
      {tabs.map((id) => (
        <InboxTabButton key={id} id={id} active={id === active} unreadQuery={`${viewQuery} is:unread ${inboxTabQuery(id, shown)}`} />
      ))}
    </div>
  );
}

function InboxTabButton({ id, active, unreadQuery }: { id: InboxTabId; active: boolean; unreadQuery: string }) {
  const { label, icon: Icon } = INBOX_TABS[id];
  const unread = useSearchFacets(unreadQuery).data?.total ?? 0;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={unread > 0 ? `${label}: ${plural(unread, "unread conversation")}` : label}
      onClick={() => useUi.getState().setInboxTab(id)}
      className={cn(
        "relative flex h-9 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active ? "font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
      <span className="min-w-0 truncate">{label}</span>
      {unread > 0 && !active ? (
        <span className="shrink-0 rounded-full bg-primary/15 px-1.5 font-medium text-[11px] text-foreground/85 tabular-nums">
          {unread >= 1000 ? "999+" : formatCount(unread)}
        </span>
      ) : null}
      {active ? <span aria-hidden className="absolute inset-x-1.5 bottom-0 h-0.5 animate-fade-in rounded-full bg-primary" /> : null}
    </button>
  );
}

function Welcome() {
  return (
    <Empty size="compact" className="h-full animate-fade-in">
      <EmptyHeader>
        <EmptyMedia>
          <MailPlusIcon className="size-8 text-muted-foreground/70" strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle className="mt-3">Add your first account</EmptyTitle>
        <EmptyDescription className="mt-1 max-w-72">
          Gmail works with an app password, Outlook with Microsoft sign-in, and any other account over IMAP. Your mail stays on
          this computer.
        </EmptyDescription>
      </EmptyHeader>
      <Button size="sm" onClick={() => useUi.getState().openDialog({ type: "add-account" })}>
        <MailPlusIcon />
        Add account
      </Button>
    </Empty>
  );
}

function RowMenuItems({
  thread,
  targets,
  state,
  actionable,
}: {
  thread: ThreadSummary;
  targets: string[];
  state: ThreadState;
  actionable: boolean;
}) {
  const settled = state === "settled";
  const many = targets.length > 1;
  const unread = thread.unreadCount > 0;
  return (
    <>
      {!many ? (
        <MenuItem onClick={() => openConversation(thread.id)}>
          <MailOpenIcon />
          Open
        </MenuItem>
      ) : null}
      {actionable ? (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => void runThreadCommand(settled ? "unsettle" : "settle", targets)}>
            {settled ? <Undo2Icon /> : <CircleCheckIcon />}
            {settled ? "Un-settle" : many ? `Settle ${targets.length}` : "Settle"}
          </MenuItem>
          {state === "waiting" ? (
            <MenuItem onClick={() => void runThreadCommand("unwait", targets)}>
              <TimerOffIcon />
              Stop waiting
            </MenuItem>
          ) : (
            <MenuSub>
              <MenuSubTrigger>
                <HourglassIcon />
                Wait for an answer
              </MenuSubTrigger>
              <MenuSubPopup className="w-60">
                <TimeMenuItems kind="wait" onPick={(until) => void runTimedCommand("wait", targets, until)} />
              </MenuSubPopup>
            </MenuSub>
          )}
          {state === "snoozed" ? (
            <MenuItem onClick={() => void runThreadCommand("unsnooze", targets)}>
              <AlarmClockOffIcon />
              Wake now
            </MenuItem>
          ) : (
            <MenuSub>
              <MenuSubTrigger>
                <AlarmClockIcon />
                {TIMED_COPY.snooze.menuTitle}
              </MenuSubTrigger>
              <MenuSubPopup className="w-60">
                <TimeMenuItems kind="snooze" onPick={(until) => void runTimedCommand("snooze", targets, until)} />
              </MenuSubPopup>
            </MenuSub>
          )}
          <MenuItem onClick={() => void runThreadCommand(state === "pinned" ? "unpin" : "pin", targets)}>
            {state === "pinned" ? <PinOffIcon /> : <PinIcon />}
            {state === "pinned" ? "Unpin" : "Pin to the top"}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {thread.inTrash ? (
        <MenuItem onClick={() => void runThreadCommand("restore", targets)}>
          <Undo2Icon />
          Restore
        </MenuItem>
      ) : thread.inInbox ? (
        <MenuItem onClick={() => void runThreadCommand("archive", targets)}>
          <ArchiveIcon />
          Archive
        </MenuItem>
      ) : (
        <MenuItem onClick={() => void runThreadCommand("moveToInbox", targets)}>
          <ArchiveRestoreIcon />
          Move to inbox
        </MenuItem>
      )}
      <MenuItem onClick={() => void runThreadCommand(unread ? "markRead" : "markUnread", targets)}>
        {unread ? <MailOpenIcon /> : <MailIcon />}
        {unread ? "Mark read" : "Mark unread"}
      </MenuItem>
      <MenuItem onClick={() => void runThreadCommand(thread.starred ? "unstar" : "star", targets)}>
        <StarIcon />
        {thread.starred ? "Unstar" : "Star"}
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger>
          <TagIcon />
          Label
        </MenuSubTrigger>
        <MenuSubPopup className="p-0">
          <LabelPickerContent threadIds={targets} />
        </MenuSubPopup>
      </MenuSub>
      <MenuSeparator />
      <MenuItem onClick={() => void runThreadCommand(thread.inSpam ? "notSpam" : "markSpam", targets)}>
        <OctagonAlertIcon />
        {thread.inSpam ? "Not spam" : "Mark as spam"}
      </MenuItem>
      {!thread.inTrash ? (
        <MenuItem variant="destructive" onClick={() => void runThreadCommand("trash", targets)}>
          <Trash2Icon />
          {many ? `Trash ${targets.length}` : "Trash"}
        </MenuItem>
      ) : null}
    </>
  );
}

function BulkBar({ view, selection }: { view: ViewRef; selection: string[] }) {
  const clear = useUi((s) => s.clearSelection);
  const notInbox = view.kind !== "inbox" && view.kind !== "unread";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <IconButton label="Clear selection" shortcut="Esc" onClick={clear}>
        <XIcon />
      </IconButton>
      <span className="me-auto min-w-0 truncate ps-1 font-medium text-sm tabular-nums">{plural(selection.length, "selected", "selected")}</span>
      {view.kind !== "trash" && view.kind !== "spam" ? (
        <IconButton label="Settle" shortcut="Ctrl+Shift+S" onClick={() => toggleSettle(selection)}>
          <CircleCheckIcon />
        </IconButton>
      ) : null}
      <IconButton label={notInbox && view.kind === "archive" ? "Move to inbox" : "Archive"} shortcut="E" onClick={() => archiveOrInbox(selection)}>
        {notInbox && view.kind === "archive" ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
      </IconButton>
      <IconButton label={view.kind === "trash" ? "Restore" : "Trash"} shortcut="#" onClick={() => trashOrRestore(selection)}>
        {view.kind === "trash" ? <Undo2Icon /> : <Trash2Icon />}
      </IconButton>
      <IconButton label="Mark read or unread" shortcut="Shift+I / Shift+U" onClick={() => toggleRead(selection)}>
        <MailOpenIcon />
      </IconButton>
      <IconButton label="Star" shortcut="S" onClick={() => toggleStar(selection)}>
        <StarIcon />
      </IconButton>
      <LabelPickerPopover
        threadIds={selection}
        trigger={
          <Button variant="ghost-muted" size="icon-sm" aria-label="Label" title="Label (L)">
            <TagIcon />
          </Button>
        }
      />
      {notInbox && view.kind !== "archive" ? (
        <IconButton label="Move to inbox" shortcut="Shift+E" onClick={() => void runThreadCommand("moveToInbox", selection)}>
          <InboxIcon />
        </IconButton>
      ) : null}
      <IconButton label={view.kind === "spam" ? "Not spam" : "Spam"} shortcut="!" onClick={() => spamOrNot(selection)}>
        <OctagonAlertIcon />
      </IconButton>
    </div>
  );
}

function RowSkeleton({ density }: { density: "comfortable" | "compact" }) {
  if (density === "compact") {
    return (
      <div className="flex h-10 items-center gap-3 border-border/50 border-b ps-9 pe-3">
        <Skeleton className="h-3 w-32 rounded-full" />
        <Skeleton className="h-3 flex-1 rounded-full" />
        <Skeleton className="h-3 w-10 rounded-full" />
      </div>
    );
  }
  return (
    <div className="flex h-[68px] flex-col justify-center gap-2.5 border-border/50 border-b ps-9 pe-3">
      <div className="flex items-center gap-3">
        <Skeleton className="h-3 w-36 rounded-full" />
        <span className="flex-1" />
        <Skeleton className="h-3 w-10 rounded-full" />
      </div>
      <Skeleton className="h-3 w-4/5 rounded-full" />
    </div>
  );
}

function ListSkeleton({ density }: { density: "comfortable" | "compact" }) {
  return (
    <div aria-busy aria-label="Loading conversations">
      {Array.from({ length: 10 }, (_, i) => (
        <RowSkeleton key={i} density={density} />
      ))}
    </div>
  );
}
