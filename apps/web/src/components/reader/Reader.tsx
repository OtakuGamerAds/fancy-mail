/**
 * The open conversation: a header strip (subject, account, labels, toolbar), the messages as
 * a timeline of cards, drafts waiting for review, and the reply box.
 */
import type { Message, ThreadDetail } from "@fancy-mail/contracts";
import {
  ArchiveIcon,
  CheckIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  LinkIcon,
  MailIcon,
  MoreHorizontalIcon,
  OctagonAlertIcon,
  PlusIcon,
  ShieldCheckIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AccountAvatar, IconButton, LabelChip } from "~/components/common";
import { ReplyArea } from "~/components/compose/ReplyComposer";
import { LabelPickerPopover } from "~/components/LabelPicker";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { toast } from "~/components/ui/toast";
import { textDirection } from "~/lib/textDirection";
import { cn, plural } from "~/lib/utils";
import { errorMessage } from "~/rpc/client";
import { modifyThreads } from "~/state/actions";
import { isSettled, runThreadCommand, toggleStar } from "~/state/commands";
import { useDirectory, useThread } from "~/state/queries";
import { formatRoute, type Route } from "~/state/router";
import { useUi } from "~/state/ui";
import { DraftCard } from "./DraftCard";
import { MessageCard } from "./MessageCard";

export function Reader({ threadId, onClose, fullWidth }: { threadId: string; onClose(): void; fullWidth: boolean }) {
  const thread = useThread(threadId);
  const detail = thread.data;

  // Opening marks it read, after 600 ms of it staying open (skimming with j/k doesn't).
  const unread = (detail?.thread.unreadCount ?? 0) > 0;
  useEffect(() => {
    if (!unread) return;
    const timer = setTimeout(() => void modifyThreads([threadId], [{ type: "markRead" }], { quiet: true }), 600);
    return () => clearTimeout(timer);
  }, [threadId, unread]);

  if (thread.isPending) return <ReaderSkeleton onClose={onClose} />;
  if (thread.isError || !detail) {
    return (
      <div className="flex h-full flex-col">
        <ReaderStrip onClose={onClose} />
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>This conversation isn't here</EmptyTitle>
            <EmptyDescription>{thread.error ? errorMessage(thread.error) : "It may have been removed."}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={onClose}>
            Back to the list
          </Button>
        </Empty>
      </div>
    );
  }
  return <ReaderContent detail={detail} onClose={onClose} fullWidth={fullWidth} />;
}

/** The header's empty strip while loading or missing (keeps the window draggable). */
function ReaderStrip({ onClose }: { onClose(): void }) {
  return (
    <div data-drag-region className="app-drag flex h-[var(--header-height)] shrink-0 items-center px-3" style={{ paddingInlineEnd: "calc(var(--wco-inset) + 0.75rem)" }}>
      <span className="flex-1" />
      <IconButton label="Close" shortcut="Esc" onClick={onClose}>
        <XIcon />
      </IconButton>
    </div>
  );
}

function ReaderSkeleton({ onClose }: { onClose(): void }) {
  return (
    <div className="flex h-full flex-col">
      <ReaderStrip onClose={onClose} />
      <div className="mx-auto w-full max-w-[52rem] space-y-4 px-6 pt-2">
        <Skeleton className="h-5 w-2/3 rounded-full" />
        <Skeleton className="h-3 w-1/3 rounded-full" />
        <div className="space-y-3 rounded-2xl bg-message p-4">
          <Skeleton className="h-3 w-1/4 rounded-full" />
          <Skeleton className="h-3 w-11/12 rounded-full" />
          <Skeleton className="h-3 w-4/5 rounded-full" />
          <Skeleton className="h-3 w-3/5 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function initiallyExpanded(messages: Message[]): Set<string> {
  const open = new Set<string>();
  messages.forEach((m, i) => {
    if (m.unread || i === messages.length - 1) open.add(m.id);
  });
  return open;
}

function ReaderContent({ detail, onClose, fullWidth }: { detail: ThreadDetail; onClose(): void; fullWidth: boolean }) {
  const dir = useDirectory();
  const editingDraftId = useUi((s) => s.editingDraftId);
  const { thread } = detail;
  const account = dir.accountById.get(thread.accountId);
  const labels = thread.labelIds.map((id) => dir.labelById.get(id)).filter((l): l is NonNullable<typeof l> => !!l);
  const messages = useMemo(
    () => (detail.drafts.length > 0 ? detail.messages.filter((m) => !m.isDraft) : detail.messages),
    [detail.messages, detail.drafts.length],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => initiallyExpanded(messages));
  const [showAllCollapsed, setShowAllCollapsed] = useState(false);
  const seenIds = useRef(new Set(messages.map((m) => m.id)));
  // New messages arriving while open start expanded.
  useEffect(() => {
    const fresh = messages.filter((m) => !seenIds.current.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) seenIds.current.add(m.id);
    setExpanded((prev) => new Set([...prev, ...fresh.map((m) => m.id)]));
  }, [messages]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // A long run of read messages folds into "N older messages", Gmail style.
  const firstExpandedAfterStart = messages.findIndex((m, i) => i > 0 && expanded.has(m.id));
  const foldStart = 1;
  const foldEnd = firstExpandedAfterStart === -1 ? messages.length - 1 : firstExpandedAfterStart;
  const foldCount = foldEnd - foldStart;
  const fold = !showAllCollapsed && foldCount >= 4;

  const subject = thread.subject.trim() || "(no subject)";
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header
        data-drag-region
        className="app-drag flex shrink-0 items-start gap-3 border-border border-b ps-5 pt-2.5 pb-3"
        style={{ paddingInlineEnd: "calc(var(--wco-inset) + 0.75rem)" }}
      >
        {fullWidth ? (
          <IconButton label="Back to the list" shortcut="Esc" onClick={onClose} className="-ms-2 mt-1">
            <ArrowLeftIcon />
          </IconButton>
        ) : null}
        <div className="min-w-0 flex-1 pt-1.5">
          <h1
            className="app-no-drag line-clamp-3 cursor-text select-text font-semibold text-lg text-foreground leading-snug tracking-tight wrap-anywhere"
            dir={textDirection(subject)}
            data-selectable
            title={subject}
          >
            {subject}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {account ? (
              <span className="app-no-drag inline-flex h-5.5 max-w-64 items-center gap-1.5 rounded-full bg-white/[0.05] ps-0.5 pe-2 text-muted-foreground text-xs" title={account.displayName}>
                <AccountAvatar account={account} size={18} />
                <span className="truncate">{account.email}</span>
              </span>
            ) : null}
            {labels.map((label) => (
              <span key={label.id} className="app-no-drag inline-flex">
                <LabelChip label={label} onRemove={() => void modifyThreads([thread.id], [{ type: "removeLabels", labelIds: [label.id] }])} />
              </span>
            ))}
            <LabelPickerPopover
              threadIds={[thread.id]}
              align="start"
              trigger={
                <button
                  type="button"
                  className="app-no-drag inline-flex h-5 cursor-pointer items-center gap-0.5 rounded-sm px-1.5 text-muted-foreground text-xs hover:bg-white/[0.06] hover:text-foreground"
                >
                  <PlusIcon className="size-3" />
                  Label
                </button>
              }
            />
          </div>
        </div>
        <Toolbar detail={detail} onClose={onClose} />
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-reader-scroll>
        <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-2 px-5 pt-4 pb-6">
          {messages.map((message, index) => {
            if (fold && index >= foldStart && index < foldEnd) {
              if (index !== foldStart) return null;
              return (
                <div key="fold" className="relative flex items-center justify-center py-1">
                  <span aria-hidden className="absolute inset-x-4 top-1/2 h-px bg-border" />
                  <button
                    type="button"
                    onClick={() => setShowAllCollapsed(true)}
                    className="relative cursor-pointer rounded-full border border-border bg-background px-3 py-1 text-muted-foreground text-xs hover:text-foreground"
                  >
                    {plural(foldCount, "older message")}
                  </button>
                </div>
              );
            }
            return (
              <MessageCard
                key={message.id}
                message={message}
                dir={dir}
                expanded={expanded.has(message.id)}
                onToggle={() => toggle(message.id)}
                threadId={thread.id}
                isLast={index === messages.length - 1}
              />
            );
          })}
          {detail.drafts.filter((d) => d.id !== editingDraftId).map((draft) => (
            <DraftCard key={draft.id} draft={draft} threadId={thread.id} />
          ))}
          <ReplyArea detail={detail} />
        </div>
      </div>
    </div>
  );
}

function Toolbar({ detail, onClose }: { detail: ThreadDetail; onClose(): void }) {
  const { thread } = detail;
  const ids = [thread.id];
  const unread = thread.unreadCount > 0;
  const settled = isSettled(thread, useDirectory().settledLabelId);
  return (
    <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
      {!thread.inTrash && !thread.inSpam ? (
        // Done with it: the first thing here, in words (as T3 Code's Settle).
        <Button
          variant="ghost-muted"
          size="compact"
          className="me-1"
          title={`${settled ? "Un-settle" : "Settle"} (Ctrl+Shift+S)`}
          onClick={() => void runThreadCommand(settled ? "unsettle" : "settle", ids)}
        >
          {settled ? <Undo2Icon /> : <CheckIcon />}
          {settled ? "Un-settle" : "Settle"}
        </Button>
      ) : null}
      {thread.inInbox ? (
        <IconButton label="Archive" shortcut="E" onClick={() => void runThreadCommand("archive", ids)}>
          <ArchiveIcon />
        </IconButton>
      ) : !thread.inTrash && !thread.inSpam ? (
        <IconButton label="Move to inbox" shortcut="Shift+E" onClick={() => void runThreadCommand("moveToInbox", ids)}>
          <ArchiveRestoreIcon />
        </IconButton>
      ) : null}
      {thread.inTrash ? (
        <IconButton label="Restore" shortcut="#" onClick={() => void runThreadCommand("restore", ids)}>
          <Undo2Icon />
        </IconButton>
      ) : (
        <IconButton label="Trash" shortcut="#" onClick={() => void runThreadCommand("trash", ids)}>
          <Trash2Icon />
        </IconButton>
      )}
      {thread.inSpam ? (
        <IconButton label="Not spam" shortcut="!" onClick={() => void runThreadCommand("notSpam", ids)}>
          <ShieldCheckIcon />
        </IconButton>
      ) : (
        <IconButton label="Spam" shortcut="!" onClick={() => void runThreadCommand("markSpam", ids)}>
          <OctagonAlertIcon />
        </IconButton>
      )}
      <IconButton
        label={unread ? "Mark read" : "Mark unread"}
        shortcut={unread ? "Shift+I" : "Shift+U"}
        onClick={() => void runThreadCommand(unread ? "markRead" : "markUnread", ids)}
      >
        <MailIcon />
      </IconButton>
      <IconButton label={thread.starred ? "Unstar" : "Star"} shortcut="S" onClick={() => toggleStar(ids)} pressed={thread.starred}>
        <StarIcon className={cn(thread.starred && "fill-amber-400 text-amber-400")} />
      </IconButton>
      <LabelPickerPopover
        threadIds={ids}
        trigger={
          <Button variant="ghost-muted" size="icon-sm" aria-label="Label" title="Label (L)">
            <TagIcon />
          </Button>
        }
      />
      <Menu>
        <MenuTrigger render={<Button variant="ghost-muted" size="icon-sm" aria-label="More" />}>
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end" className="w-56">
          <MenuItem
            onClick={() => {
              const route = useUi.getState().route;
              const link: Route =
                route.page === "mail" ? { ...route, threadId: thread.id } : { page: "mail", view: { kind: "all", scope: { type: "all" } }, threadId: thread.id };
              const url = `${window.location.origin}${window.location.pathname}${formatRoute(link)}`;
              navigator.clipboard.writeText(url).then(
                () => toast.show({ title: "Link copied", duration: 2500 }),
                () => toast.error("Couldn't copy the link"),
              );
            }}
          >
            <LinkIcon />
            Copy link to conversation
          </MenuItem>
        </MenuPopup>
      </Menu>
      <IconButton label="Close" shortcut="Esc" onClick={onClose}>
        <XIcon />
      </IconButton>
    </div>
  );
}

