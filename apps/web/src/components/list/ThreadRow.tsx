/**
 * One conversation in the list. Comfortable: two lines in 68 px (people · date, labels then
 * subject — snippet). Compact: one line in 40 px. Hover shows quick actions where the date is;
 * the checkbox takes the unread dot's place on hover or while anything is checked.
 * Where it stands shows too: pinned (a pin), waiting or snoozed (when it comes back, in place
 * of the date), settled (dimmed until hovered), and why it came back ("Replied", "No reply").
 * Hover offers Wait, Snooze and Settle; swiping a row to the left settles it (or un-settles a
 * settled one).
 */
import type { ThreadMark, ThreadSummary, ThreadTimer } from "@fancy-mail/contracts";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  HourglassIcon,
  PinIcon,
  TimerOffIcon,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
  StarIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { memo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { AccountAvatar, LabelChip } from "~/components/common";
import { TIMED_COPY, TimeMenuItems, type TimedKind } from "~/components/StateMenus";
import { Menu, MenuGroupLabel, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { CheckboxMark } from "~/components/ui/checkbox";
import { displayName } from "~/lib/addresses";
import { formatExact, formatListDate } from "~/lib/format";
import { formatLeft, formatWhen } from "~/lib/stateTimes";
import { cn } from "~/lib/utils";
import { useSwipeAction } from "~/hooks/useSwipeAction";
import { runThreadCommand, runTimedCommand, toggleStar, type ThreadState } from "~/state/commands";
import type { Directory } from "~/state/queries";

export const ROW_HEIGHT = { comfortable: 68, compact: 40 } as const;

export function participantsText(thread: ThreadSummary, dir: Directory): string {
  // A new message still being written: who it is for.
  if (thread.messageCount === 0 && thread.draftCount > 0) {
    return thread.participants.length > 0 ? `To ${thread.participants.map((p) => displayName(p)).join(", ")}` : "No recipients yet";
  }
  const names = thread.participants.map((p) =>
    dir.ownAddresses.has(p.address.toLowerCase()) ? "me" : displayName(p),
  );
  const unique = names.filter((n, i) => names.indexOf(n) === i);
  if (unique.length === 0) return "(no sender)";
  if (unique.length === 1) return unique[0]!;
  const first = (n: string) => (n === "me" ? n : n.split(/\s+/)[0]!);
  if (unique.length === 2) return `${first(unique[0]!)}, ${first(unique[1]!)}`;
  return `${first(unique[0]!)} … ${first(unique[unique.length - 2]!)}, ${first(unique[unique.length - 1]!)}`;
}

interface ThreadRowProps {
  thread: ThreadSummary;
  dir: Directory;
  density: "comfortable" | "compact";
  open: boolean;
  focused: boolean;
  checked: boolean;
  selectionMode: boolean;
  showAccount: boolean;
  /** Hide this label's chip (the view is that label). */
  hideLabelId: string | null;
  /** Where it stands (from its labels). */
  state: ThreadState;
  /** When it comes back, if it waits or is snoozed. */
  timer: ThreadTimer | null;
  /** Why it came back ("Replied", "No reply", "Woke"), until it's opened. */
  mark: ThreadMark | null;
  /** Can be settled, waited on or snoozed here (not a new message being written, not in the trash or spam). */
  actionable: boolean;
  onRowClick(event: ReactMouseEvent, thread: ThreadSummary): void;
  onToggleCheck(event: ReactMouseEvent, thread: ThreadSummary): void;
  onContextMenu(event: ReactMouseEvent, thread: ThreadSummary): void;
}

/** Settle / Un-settle on hover: a word, not just an icon, as T3 Code's thread rows have. */
function SettleAction({ settled, onClick }: { settled: boolean; onClick(): void }) {
  const label = settled ? "Un-settle" : "Settle";
  return (
    <button
      type="button"
      aria-label={`${label} conversation`}
      title={`${label} conversation (Ctrl+Shift+S)`}
      className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-muted-foreground text-xs outline-none hover:bg-white/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {settled ? <Undo2Icon className="size-3.5" /> : <CheckIcon className="size-3.5" />}
      {label}
    </button>
  );
}

const MARKS: Record<ThreadMark["kind"], { label: string; className: string; title: string }> = {
  replied: { label: "Replied", className: "bg-primary/15 text-primary", title: "An answer came while you were waiting" },
  noReply: { label: "No reply", className: "bg-amber-500/15 text-amber-300", title: "You waited and no answer came: time to follow up" },
  woke: { label: "Back", className: "bg-sky-500/15 text-sky-300", title: "Back from snooze" },
};

const quickActionClass =
  "grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-white/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-white/8 data-[popup-open]:text-foreground [&>svg]:size-4";

/** Wait / Snooze on hover: a menu of times. */
function TimedAction({ kind, threadId, onOpenChange }: { kind: TimedKind; threadId: string; onOpenChange(open: boolean): void }) {
  const Icon = kind === "wait" ? HourglassIcon : AlarmClockIcon;
  const label = kind === "wait" ? "Wait for an answer" : "Snooze";
  return (
    <Menu onOpenChange={onOpenChange}>
      <MenuTrigger
        render={<button type="button" aria-label={label} title={label} className={quickActionClass} />}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <Icon />
      </MenuTrigger>
      <MenuPopup align="end" className="w-60" onClick={(event) => event.stopPropagation()}>
        <MenuGroupLabel>{TIMED_COPY[kind].menuTitle}</MenuGroupLabel>
        <TimeMenuItems kind={kind} onPick={(until) => void runTimedCommand(kind, [threadId], until)} />
      </MenuPopup>
    </Menu>
  );
}

function QuickAction({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={quickActionClass}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {children}
    </button>
  );
}

export const ThreadRow = memo(function ThreadRow({
  thread,
  dir,
  density,
  open,
  focused,
  checked,
  selectionMode,
  showAccount,
  hideLabelId,
  state,
  timer,
  mark,
  actionable,
  onRowClick,
  onToggleCheck,
  onContextMenu,
}: ThreadRowProps) {
  const settled = state === "settled";
  // Out of the way (settled, waiting, snoozed): dimmed until hovered.
  const away = state === "settled" || state === "waiting" || state === "snoozed";
  const settle = () => void runThreadCommand(settled ? "unsettle" : "settle", [thread.id]);
  const swipe = useSwipeAction(actionable ? settle : null);
  // A menu opened from the hover actions keeps them shown.
  const [menuOpen, setMenuOpen] = useState(false);
  const unread = thread.unreadCount > 0;
  const account = dir.accountById.get(thread.accountId);
  const labels = thread.labelIds
    .filter((id) => id !== hideLabelId)
    .map((id) => dir.labelById.get(id))
    .filter((l): l is NonNullable<typeof l> => !!l);
  const compactRow = density === "compact";
  const shownLabels = labels.slice(0, compactRow ? 2 : 3);
  const people = participantsText(thread, dir);
  const subject = thread.subject.trim() || "(no subject)";
  const compact = density === "compact";

  const quickActions = (
    <span className="flex items-center gap-0.5">
      {thread.inTrash ? (
        <QuickAction label="Restore" onClick={() => void runThreadCommand("restore", [thread.id])}>
          <Undo2Icon />
        </QuickAction>
      ) : thread.inInbox ? (
        <QuickAction label="Archive (E)" onClick={() => void runThreadCommand("archive", [thread.id])}>
          <ArchiveIcon />
        </QuickAction>
      ) : (
        <QuickAction label="Move to inbox (Shift+E)" onClick={() => void runThreadCommand("moveToInbox", [thread.id])}>
          <ArchiveRestoreIcon />
        </QuickAction>
      )}
      {!thread.inTrash ? (
        <QuickAction label="Trash (#)" onClick={() => void runThreadCommand("trash", [thread.id])}>
          <Trash2Icon />
        </QuickAction>
      ) : null}
      <QuickAction
        label={unread ? "Mark read (Shift+I)" : "Mark unread (Shift+U)"}
        onClick={() => void runThreadCommand(unread ? "markRead" : "markUnread", [thread.id])}
      >
        {unread ? <MailOpenIcon /> : <MailIcon />}
      </QuickAction>
      <QuickAction label={thread.starred ? "Unstar (S)" : "Star (S)"} onClick={() => toggleStar([thread.id])}>
        <StarIcon className={cn(thread.starred && "fill-amber-400 text-amber-400")} />
      </QuickAction>
      {actionable ? (
        <>
          {state === "waiting" ? (
            <QuickAction label="Stop waiting" onClick={() => void runThreadCommand("unwait", [thread.id])}>
              <TimerOffIcon />
            </QuickAction>
          ) : (
            <TimedAction kind="wait" threadId={thread.id} onOpenChange={setMenuOpen} />
          )}
          {state === "snoozed" ? (
            <QuickAction label="Wake now" onClick={() => void runThreadCommand("unsnooze", [thread.id])}>
              <AlarmClockOffIcon />
            </QuickAction>
          ) : (
            <TimedAction kind="snooze" threadId={thread.id} onOpenChange={setMenuOpen} />
          )}
          <SettleAction settled={settled} onClick={settle} />
        </>
      ) : null}
    </span>
  );

  const leading = (
    <span
      className="relative grid w-5 shrink-0 cursor-pointer place-items-center self-stretch"
      onClick={(event) => {
        event.stopPropagation();
        onToggleCheck(event, thread);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Uncheck conversation" : "Check conversation"}
    >
      <span className={cn("absolute", checked || selectionMode ? "opacity-100" : "opacity-0 group-hover/thread:opacity-100")}>
        <CheckboxMark checked={checked} />
      </span>
      {unread ? (
        <span
          aria-hidden
          className={cn("size-2 rounded-full bg-primary", (checked || selectionMode) ? "opacity-0" : "group-hover/thread:opacity-0")}
        />
      ) : null}
    </span>
  );

  // Waiting or snoozed: when it comes back, in place of the date.
  const until =
    timer && (state === "waiting" || state === "snoozed") ? (
      <span
        className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs tabular-nums"
        title={`${state === "waiting" ? "Waiting for an answer until" : "Snoozed until"} ${formatWhen(timer.until)}`}
      >
        {state === "waiting" ? <HourglassIcon className="size-3" /> : <AlarmClockIcon className="size-3" />}
        {formatLeft(timer.until)}
      </span>
    ) : null;

  const date = until ?? (
    <time
      dateTime={new Date(thread.lastMessageAt).toISOString()}
      title={formatExact(thread.lastMessageAt)}
      className={cn("shrink-0 text-xs tabular-nums", unread ? "font-semibold text-foreground" : "text-muted-foreground")}
    >
      {formatListDate(thread.lastMessageAt)}
    </time>
  );

  const extras = (
    <span className="flex shrink-0 items-center gap-1">
      {thread.hasAttachments ? <PaperclipIcon aria-label="Has attachments" className="size-3.5 text-muted-foreground" /> : null}
      {thread.starred ? <StarIcon aria-label="Starred" className="size-3.5 fill-amber-400 text-amber-400" /> : null}
      {state === "pinned" ? <PinIcon aria-label="Pinned" className="size-3.5 text-muted-foreground" /> : null}
    </span>
  );

  const peopleEl = (
    <span className={cn("flex min-w-0 items-center gap-1.5", compact ? "w-[32%] min-w-24 max-w-48 shrink-0" : "flex-1")}>
      {showAccount && account ? (
        // The account's avatar, as in the sidebar (a dot would read as the unread dot).
        <span title={account.email} className={cn("flex shrink-0", away && "opacity-50 grayscale group-hover/thread:opacity-100 group-hover/thread:grayscale-0")}>
          <AccountAvatar account={account} size={16} />
        </span>
      ) : null}
      <span className={cn("min-w-0 truncate", unread ? "font-semibold text-foreground" : "text-foreground/85")}>
        {people.split(/(, | … )/).map((part, i) => (i % 2 === 1 ? part : <bdi key={i}>{part}</bdi>))}
      </span>
      {thread.messageCount > 1 ? (
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">({thread.messageCount})</span>
      ) : null}
    </span>
  );

  const subjectLine = (
    <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
      {mark ? (
        <span title={MARKS[mark.kind].title} className={cn("me-0.5 shrink-0 rounded px-1.5 py-px font-medium text-[11px]", MARKS[mark.kind].className)}>
          {MARKS[mark.kind].label}
        </span>
      ) : null}
      {thread.draftCount > 0 ? <span className="me-0.5 shrink-0 text-destructive-foreground text-xs font-medium">Draft</span> : null}
      {shownLabels.map((label) => (
        <LabelChip key={label.id} label={label} className="max-w-28 shrink-0" />
      ))}
      {labels.length > shownLabels.length ? (
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums" title={labels.slice(shownLabels.length).map((l) => l.name).join(", ")}>
          +{labels.length - shownLabels.length}
        </span>
      ) : null}
      <span className={cn("ms-0.5 min-w-0 truncate", unread ? "font-semibold text-foreground" : "text-foreground/90")}>
        <bdi>{subject}</bdi>
        {thread.snippet ? (
          <span className="font-normal text-muted-foreground">
            {" — "}
            <bdi>{thread.snippet}</bdi>
          </span>
        ) : null}
      </span>
    </span>
  );

  const row = (
    <div
      role="option"
      aria-selected={open}
      data-thread-id={thread.id}
      data-focused={focused || undefined}
      data-state={state}
      className={cn(
        "group/thread relative flex w-full cursor-pointer select-none items-center gap-2 border-border/50 border-b ps-2 pe-3 text-sm",
        compact ? "h-10" : "h-[68px]",
        open ? "bg-white/[0.075]" : checked ? "bg-primary/10" : "hover:bg-white/[0.035]",
        focused && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ring)_75%,transparent)]",
        // Out of the way: everything muted until hovered (as T3 Code's settled threads).
        away && !open && "[&:not(:hover):not(:focus-within)_*]:text-muted-foreground/80",
      )}
      onClick={(event) => onRowClick(event, thread)}
      onContextMenu={(event) => onContextMenu(event, thread)}
    >
      {leading}
      {compact ? (
        <span className="flex min-w-0 flex-1 items-center gap-3">
          {peopleEl}
          {subjectLine}
          {extras}
          <span className="relative flex w-16 shrink-0 justify-end">
            <span className={cn("group-hover/thread:invisible", menuOpen && "invisible")}>{date}</span>
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <span className="flex min-w-0 items-center gap-2">
            {peopleEl}
            <span className={cn("group-hover/thread:invisible", menuOpen && "invisible")}>{date}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            {subjectLine}
            {extras}
          </span>
        </span>
      )}
      <span
        className={cn(
          "pointer-events-none absolute end-2 flex items-center rounded-lg opacity-0 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100",
          menuOpen && "pointer-events-auto opacity-100",
          compact ? "inset-y-0" : "top-1.5",
        )}
      >
        <span className={cn("flex items-center rounded-lg px-0.5", open ? "bg-[color-mix(in_srgb,#fff_7.5%,#000)]" : checked ? "bg-[color-mix(in_srgb,var(--primary)_10%,#000)]" : "bg-[color-mix(in_srgb,#fff_3.5%,#000)]")}>
          {quickActions}
        </span>
      </span>
    </div>
  );

  const { offset, armed, dragging } = swipe.state;
  const SwipeIcon = settled ? Undo2Icon : CheckIcon;
  return (
    <div className="relative h-full touch-pan-y overflow-hidden" {...swipe.handlers}>
      {offset < 0 ? (
        // What a swipe uncovers: the action, armed (stronger) once letting go would run it.
        <div
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center justify-end gap-2 pe-5 font-medium text-xs transition-colors duration-150",
            armed ? "bg-primary/25 text-foreground" : "bg-primary/10 text-muted-foreground",
          )}
        >
          {settled ? "Un-settle" : "Settle"}
          <span
            className={cn(
              "grid size-8 place-items-center rounded-full bg-primary text-primary-foreground transition-transform duration-150",
              armed ? "scale-110" : "scale-90",
            )}
          >
            <SwipeIcon className="size-4" />
          </span>
        </div>
      ) : null}
      <div
        className={cn("h-full bg-background", !dragging && "transition-transform duration-200 ease-out")}
        style={offset !== 0 ? { transform: `translateX(${offset}px)` } : undefined}
      >
        {row}
      </div>
    </div>
  );
});
