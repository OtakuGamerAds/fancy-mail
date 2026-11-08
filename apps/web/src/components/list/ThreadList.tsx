/**
 * The conversation list: a header strip (title, scope, count, sync, select all — or the bulk
 * bar while rows are checked), the in-view search, filter chips, and the virtualized rows.
 */
import { QUERY_SYNTAX_HELP, type ThreadSummary } from "@fancy-mail/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleHelpIcon,
  InboxIcon,
  MailIcon,
  MailOpenIcon,
  OctagonAlertIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { IconButton, ShowSidebarButton } from "~/components/common";
import { LabelPickerContent, LabelPickerPopover } from "~/components/LabelPicker";
import { DemoBanner } from "~/components/list/DemoBanner";
import { ROW_HEIGHT, ThreadRow } from "~/components/list/ThreadRow";
import { useRowMenu } from "~/components/sidebar/EntityMenus";
import { Button } from "~/components/ui/button";
import { CheckboxMark } from "~/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Skeleton } from "~/components/ui/skeleton";
import { useDebounced } from "~/hooks/useDebounced";
import { formatCount } from "~/lib/format";
import { cn, plural } from "~/lib/utils";
import { errorMessage } from "~/rpc/client";
import { syncNow } from "~/state/actions";
import { archiveOrInbox, runThreadCommand, spamOrNot, toggleRead, toggleStar, trashOrRestore } from "~/state/commands";
import { listNav } from "~/state/listNav";
import { useBootstrap, useDirectory, useThreads } from "~/state/queries";
import { navigate, viewKey, type ViewRef } from "~/state/router";
import { useUi, type ListFilter } from "~/state/ui";
import { describeView, listQuery } from "~/state/view";

const FILTERS: { id: ListFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "starred", label: "Starred" },
  { id: "attachments", label: "Attachments" },
];

const EXAMPLES = ["from:anna has:attachment", "is:unread newer_than:7d"];

export function ThreadList({ view, rightmost }: { view: ViewRef; rightmost: boolean }) {
  const { data: bootstrap } = useBootstrap();
  const dir = useDirectory();
  const info = describeView(view, bootstrap);
  const density = bootstrap?.settings.density ?? "comfortable";

  const openThreadId = useUi((s) => (s.route.page === "mail" ? s.route.threadId : null));
  const focusedThreadId = useUi((s) => s.focusedThreadId);
  const selection = useUi((s) => s.selection);
  const filter = useUi((s) => s.listFilter);

  // ── Search within the view ──
  const isSearchView = view.kind === "search";
  const listSearch = useUi((s) => s.listSearch);
  const [searchViewText, setSearchViewText] = useState(isSearchView ? view.query : "");
  /** The query this field last put in the address (so its own echo doesn't overwrite typing). */
  const pushedQuery = useRef<string | null>(null);
  const routeQuery = view.kind === "search" ? view.query : null;
  useEffect(() => {
    if (routeQuery === null || routeQuery === pushedQuery.current) return;
    // Changed from outside (the palette, a link): show it.
    setSearchViewText(routeQuery);
  }, [routeQuery]);
  const typed = isSearchView ? searchViewText : listSearch;
  const debouncedTyped = useDebounced(typed, 150);

  useEffect(() => {
    if (view.kind !== "search") return;
    if (debouncedTyped === view.query) return;
    pushedQuery.current = debouncedTyped;
    navigate({ page: "mail", view: { ...view, query: debouncedTyped }, threadId: null }, { replace: true });
  }, [debouncedTyped, view]);

  const query = info.query === null ? null : listQuery(info.query, isSearchView ? "" : debouncedTyped, filter);
  // Typing a search or switching a filter keeps the current rows until the new ones arrive;
  // another view starts fresh.
  const thisViewKey = viewKey(view);
  const lastViewKey = useRef(thisViewKey);
  const sameView = lastViewKey.current === thisViewKey || view.kind === "search";
  useEffect(() => {
    lastViewKey.current = thisViewKey;
  }, [thisViewKey]);
  const threadsQuery = useThreads(query, sameView);
  const threads = useMemo(() => threadsQuery.data?.pages.flatMap((p) => p.threads) ?? [], [threadsQuery.data]);
  const firstPage = threadsQuery.data?.pages[0];
  const total = firstPage?.total ?? 0;
  const queryErrors = firstPage?.queryErrors ?? [];

  // ── Virtual rows ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = ROW_HEIGHT[density];
  const virtualizer = useVirtualizer({
    count: threads.length + (threadsQuery.hasNextPage ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: (index) => threads[index]?.id ?? `loader-${index}`,
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

  // Back to the top when the view or the search changes.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [query]);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    listNav.threads = threads;
  }, [threads]);
  useEffect(() => {
    listNav.scrollToIndex = (index) => virtualizer.scrollToIndex(index, { align: "auto" });
    listNav.focusSearch = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
  }, [virtualizer]);

  // ── Clicks ──
  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const selectionMode = selection.length > 0;

  const toggleCheck = useCallback(
    (event: ReactMouseEvent, thread: ThreadSummary) => {
      const ui = useUi.getState();
      if (event.shiftKey && ui.selectionAnchor) {
        const from = threads.findIndex((t) => t.id === ui.selectionAnchor);
        const to = threads.findIndex((t) => t.id === thread.id);
        if (from !== -1 && to !== -1) {
          const [a, b] = from < to ? [from, to] : [to, from];
          const range = threads.slice(a, b + 1).map((t) => t.id);
          ui.setSelection([...new Set([...ui.selection, ...range])], ui.selectionAnchor);
          return;
        }
      }
      const has = ui.selection.includes(thread.id);
      ui.setSelection(has ? ui.selection.filter((id) => id !== thread.id) : [...ui.selection, thread.id], thread.id);
      ui.setFocusedThread(thread.id);
    },
    [threads],
  );

  const onRowClick = useCallback(
    (event: ReactMouseEvent, thread: ThreadSummary) => {
      const ui = useUi.getState();
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        toggleCheck(event, thread);
        return;
      }
      ui.setFocusedThread(thread.id);
      ui.setFocusZone("list");
      const route = ui.route;
      if (route.page === "mail") navigate({ page: "mail", view: route.view, threadId: thread.id });
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
  const allChecked = threads.length > 0 && threads.every((t) => selectionSet.has(t.id));
  const someChecked = selectionMode && !allChecked;
  const toggleAll = () => {
    const ui = useUi.getState();
    if (allChecked || someChecked) ui.clearSelection();
    else ui.setSelection(threads.map((t) => t.id), threads[0]?.id ?? null);
  };

  const hideLabelId = view.kind === "label" ? view.labelId : null;
  const isPending = threadsQuery.isPending && query !== null;
  const showEmpty = !isPending && !threadsQuery.isError && threads.length === 0;
  const searching = (isSearchView ? searchViewText : debouncedTyped).trim().length > 0 || filter !== "all";

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
            <div className="flex min-w-0 flex-1 items-baseline gap-2 ps-1">
              <h1 className="truncate font-semibold text-[15px] text-foreground tracking-tight" data-selectable>
                {info.title}
              </h1>
              {info.scopeLabel ? (
                <span className="max-w-40 shrink truncate rounded-md bg-white/[0.06] px-1.5 py-0.5 text-muted-foreground text-xs">
                  {info.scopeLabel}
                </span>
              ) : null}
              {firstPage ? (
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {total >= 10_000 ? "10,000+" : formatCount(total)}
                </span>
              ) : null}
            </div>
            <IconButton
              label={info.scope.type === "account" ? "Sync this account" : "Sync now"}
              onClick={() => syncNow(info.scope.type === "account" ? info.scope.accountId : undefined)}
            >
              <RefreshCwIcon />
            </IconButton>
          </>
        )}
        <button
          type="button"
          role="checkbox"
          aria-checked={allChecked ? true : someChecked ? "mixed" : false}
          aria-label={allChecked || someChecked ? "Uncheck all" : "Check all"}
          title={allChecked || someChecked ? "Uncheck all" : "Check all loaded"}
          disabled={threads.length === 0}
          onClick={toggleAll}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
        >
          {someChecked ? (
            <span className="grid size-4 place-items-center rounded-[.25rem] border border-primary bg-primary text-primary-foreground">
              <span className="h-0.5 w-2 rounded-full bg-current" />
            </span>
          ) : (
            <CheckboxMark checked={allChecked} />
          )}
        </button>
      </div>

      {/* Search within the view */}
      <div className="shrink-0 px-3 pb-2">
        <div className="relative flex h-8 items-center rounded-lg border border-input bg-input/32 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
          <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground/70" />
          <input
            ref={searchRef}
            value={typed}
            onChange={(event) => {
              if (isSearchView) setSearchViewText(event.target.value);
              else useUi.getState().setListSearch(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (typed) {
                  if (isSearchView) setSearchViewText("");
                  else useUi.getState().setListSearch("");
                } else {
                  event.currentTarget.blur();
                }
              } else if (event.key === "ArrowDown" || event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
                const first = listNav.threads[0];
                if (first) useUi.getState().setFocusedThread(first.id);
              }
            }}
            placeholder={isSearchView ? "Search all mail" : `Search in ${info.title}`}
            aria-label="Search in this view"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent ps-8 pe-1 text-sm leading-8 outline-none placeholder:text-placeholder"
          />
          {typed ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => (isSearchView ? setSearchViewText("") : useUi.getState().setListSearch(""))}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
          <SyntaxHelp />
        </div>
        {queryErrors.length > 0 && threads.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5 text-warning-foreground/90 text-xs">
            {queryErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Filter chips */}
      <div className="flex shrink-0 items-center gap-1 border-border border-b px-3 pb-2" role="tablist" aria-label="Filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => useUi.getState().setListFilter(f.id)}
            className={cn(
              "h-6 cursor-pointer rounded-full px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              filter === f.id
                ? "bg-white/[0.09] font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {bootstrap?.hasDemoData ? <DemoBanner /> : null}

      {/* Rows */}
      <div ref={scrollRef} role="listbox" aria-label="Conversations" className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden [overflow-anchor:none]">
        {isPending ? (
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
            <Empty size="compact" className="h-full">
              <EmptyHeader>
                <EmptyMedia>
                  <InboxIcon className="size-8 text-muted-foreground/60" strokeWidth={1.5} />
                </EmptyMedia>
                <EmptyTitle className="mt-3 text-muted-foreground">All caught up</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <Empty size="compact" className="h-full">
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
                        onClick={() => {
                          if (isSearchView) setSearchViewText(example);
                          else useUi.getState().setListSearch(example);
                        }}
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
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((item) => {
              const thread = threads[item.index];
              return (
                <div
                  key={item.key}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: rowHeight, transform: `translateY(${item.start}px)` }}
                >
                  {thread ? (
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
                      onRowClick={onRowClick}
                      onToggleCheck={toggleCheck}
                      onContextMenu={onContextMenu}
                    />
                  ) : (
                    <RowSkeleton density={density} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Menu open={rowMenu.open} onOpenChange={rowMenu.setOpen} modal={false}>
        <MenuPopup anchor={rowMenu.anchor ?? undefined} align="start" className="w-56">
          {menuThread ? <RowMenuItems thread={menuThread} targets={menuTargets} view={view} /> : null}
        </MenuPopup>
      </Menu>
    </section>
  );
}

function RowMenuItems({ thread, targets, view }: { thread: ThreadSummary; targets: string[]; view: ViewRef }) {
  const many = targets.length > 1;
  const unread = thread.unreadCount > 0;
  return (
    <>
      {!many ? (
        <MenuItem
          onClick={() => {
            const route = useUi.getState().route;
            if (route.page === "mail") navigate({ page: "mail", view, threadId: thread.id });
          }}
        >
          <MailOpenIcon />
          Open
        </MenuItem>
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

function SyntaxHelp() {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Search syntax"
            title="Search syntax"
            className="me-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          />
        }
      >
        <CircleHelpIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <div className="space-y-2 py-1">
          <div className="font-medium text-sm">Search syntax</div>
          <ul className="space-y-1 text-muted-foreground text-xs leading-relaxed" data-selectable>
            {QUERY_SYNTAX_HELP.split("\n").map((line) => (
              <li key={line} className={cn(line.startsWith("  ") && "ps-3")}>
                {line.trim()}
              </li>
            ))}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
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
