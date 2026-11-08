/**
 * Activity: everything that changed, by whom (you, an agent, sync), with Undo. A page
 * (#/activity) and a sheet from the right (the sidebar footer). Clicking an entry shows its
 * conversations.
 */
import type { Activity } from "@fancy-mail/contracts";
import { BotIcon, HistoryIcon, RefreshCwIcon, SparklesIcon, UserIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { IconButton, ShowSidebarButton } from "~/components/common";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { actorLabel } from "~/lib/agents";
import { formatExact, formatRelative } from "~/lib/format";
import { cn } from "~/lib/utils";
import { errorMessage } from "~/rpc/client";
import { undoActivity } from "~/state/actions";
import { showThreadsOf, useLive } from "~/state/events";
import { useActivity } from "~/state/queries";
import { navigate } from "~/state/router";
import { useUi } from "~/state/ui";

function ActorIcon({ activity }: { activity: Activity }) {
  const { actor } = activity;
  if (actor.kind === "agent")
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-info/14 text-info-foreground">
        <SparklesIcon className="size-3.5" />
      </span>
    );
  if (actor.kind === "sync")
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-muted-foreground">
        <RefreshCwIcon className="size-3.5" />
      </span>
    );
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.06] text-muted-foreground">
      <UserIcon className="size-3.5" />
    </span>
  );
}

function ActivityRow({ activity, onOpen }: { activity: Activity; onOpen(): void }) {
  const undone = activity.undoneAt !== null;
  return (
    <li
      className={cn(
        "group/act flex items-start gap-3 rounded-xl px-3 py-2.5",
        activity.threadIds.length > 0 && "cursor-pointer hover:bg-white/[0.035]",
      )}
      onClick={activity.threadIds.length > 0 ? onOpen : undefined}
    >
      <ActorIcon activity={activity} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className={cn("shrink-0 font-medium text-sm", activity.actor.kind === "agent" ? "text-info-foreground" : "text-foreground")}>
            {actorLabel(activity.actor)}
          </span>
          <time className="shrink-0 text-muted-foreground text-xs" title={formatExact(activity.at)}>
            {formatRelative(activity.at)}
          </time>
        </div>
        <p className={cn("text-sm wrap-anywhere", undone ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground/90")}>
          {activity.summary}
        </p>
      </div>
      <div className="flex shrink-0 items-center self-center">
        {undone ? (
          <span className="px-2 text-muted-foreground text-xs">Undone</span>
        ) : activity.undoable ? (
          <Button
            size="xs"
            variant="outline"
            onClick={(event) => {
              event.stopPropagation();
              void undoActivity(activity.id);
            }}
          >
            Undo
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function ActivityList({ onNavigate }: { onNavigate?: () => void }) {
  const activity = useActivity();
  const items = activity.data?.pages.flatMap((p) => p.items) ?? [];
  const markSeen = useUi((s) => s.markActivitySeen);
  const latestAgent = useLive((s) => s.latestAgentActivityAt);
  const sentinel = useRef<HTMLDivElement>(null);

  // Looking at Activity clears the footer's dot.
  useEffect(() => {
    const newest = Math.max(items[0]?.at ?? 0, latestAgent);
    if (newest > 0) markSeen(newest);
  }, [items, latestAgent, markSeen]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && activity.hasNextPage && !activity.isFetchingNextPage) {
        void activity.fetchNextPage();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activity]);

  if (activity.isPending) {
    return (
      <div className="space-y-4 p-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-24 rounded-full" />
              <Skeleton className="h-3 w-3/4 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (activity.isError) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>Couldn't load Activity</EmptyTitle>
          <EmptyDescription>{errorMessage(activity.error)}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={() => void activity.refetch()}>
          Try again
        </Button>
      </Empty>
    );
  }
  if (items.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia>
            <HistoryIcon className="size-8 text-muted-foreground/50" strokeWidth={1.5} />
          </EmptyMedia>
          <EmptyTitle className="mt-3 text-muted-foreground">Nothing yet</EmptyTitle>
          <EmptyDescription>Changes you and your agents make show up here, each with Undo.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <ul className="space-y-0.5 p-2">
        {items.map((item) => (
          <ActivityRow
            key={item.id}
            activity={item}
            onOpen={() => {
              onNavigate?.();
              showThreadsOf(item);
            }}
          />
        ))}
      </ul>
      <div ref={sentinel} className="flex h-10 items-center justify-center">
        {activity.isFetchingNextPage ? <Spinner size="sm" tone="muted" /> : null}
      </div>
    </>
  );
}

export function ActivityPage() {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div
        data-drag-region
        className="app-drag flex h-[var(--header-height)] shrink-0 items-center gap-2 ps-5"
        style={{ paddingInlineEnd: "calc(var(--wco-inset) + 0.75rem)" }}
      >
        <ShowSidebarButton />
        <h1 className="flex-1 font-semibold text-[15px] tracking-tight">Activity</h1>
        <IconButton label="Close" shortcut="Esc" onClick={() => navigate({ page: "mail", view: { kind: "inbox", scope: { type: "all" } }, threadId: null })}>
          <XIcon />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-3 pb-8">
          <p className="flex items-center gap-2 px-3 pb-2 text-muted-foreground text-sm">
            <BotIcon className="size-4 shrink-0" />
            Every change, by you or an agent, with a way back.
          </p>
          <ActivityList />
        </div>
      </div>
    </div>
  );
}

export function ActivitySheet() {
  const open = useUi((s) => s.activitySheetOpen);
  const setOpen = useUi((s) => s.setActivitySheetOpen);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetPopup side="right" showCloseButton={false} className="max-w-md" style={{ paddingTop: "var(--wco-height)" }}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SheetTitle className="flex-1 text-base">Activity</SheetTitle>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => {
              setOpen(false);
              navigate({ page: "activity" });
            }}
          >
            Open as page
          </Button>
          <IconButton label="Close" shortcut="Esc" onClick={() => setOpen(false)}>
            <XIcon />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{open ? <ActivityList onNavigate={() => setOpen(false)} /> : null}</div>
      </SheetPopup>
    </Sheet>
  );
}
