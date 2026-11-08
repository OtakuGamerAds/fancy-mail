/**
 * One conversation in the list. Comfortable: two lines in 68 px (people · date, subject —
 * snippet · labels). Compact: one line in 40 px. Hover shows quick actions where the date is;
 * the checkbox takes the unread dot's place on hover or while anything is checked.
 */
import type { ThreadSummary } from "@fancy-mail/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
  StarIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { ColorDot, LabelChip } from "~/components/common";
import { CheckboxMark } from "~/components/ui/checkbox";
import { displayName } from "~/lib/addresses";
import { formatExact, formatListDate } from "~/lib/format";
import { cn } from "~/lib/utils";
import { runThreadCommand, toggleStar } from "~/state/commands";
import type { Directory } from "~/state/queries";

export const ROW_HEIGHT = { comfortable: 68, compact: 40 } as const;

export function participantsText(thread: ThreadSummary, dir: Directory): string {
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
  onRowClick(event: ReactMouseEvent, thread: ThreadSummary): void;
  onToggleCheck(event: ReactMouseEvent, thread: ThreadSummary): void;
  onContextMenu(event: ReactMouseEvent, thread: ThreadSummary): void;
}

function QuickAction({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-white/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4"
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
  onRowClick,
  onToggleCheck,
  onContextMenu,
}: ThreadRowProps) {
  const unread = thread.unreadCount > 0;
  const account = dir.accountById.get(thread.accountId);
  const labels = thread.labelIds
    .filter((id) => id !== hideLabelId)
    .map((id) => dir.labelById.get(id))
    .filter((l): l is NonNullable<typeof l> => !!l);
  const compactRow = density === "compact";
  const shownLabels = labels.slice(0, compactRow ? 1 : 2);
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

  const date = (
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
      {shownLabels.map((label) => (
        <LabelChip key={label.id} label={label} className="max-w-24" />
      ))}
      {labels.length > shownLabels.length ? (
        <span className="text-muted-foreground text-xs tabular-nums">+{labels.length - shownLabels.length}</span>
      ) : null}
      {thread.hasAttachments ? <PaperclipIcon aria-label="Has attachments" className="size-3.5 text-muted-foreground" /> : null}
      {thread.starred ? <StarIcon aria-label="Starred" className="size-3.5 fill-amber-400 text-amber-400" /> : null}
    </span>
  );

  const peopleEl = (
    <span className={cn("flex min-w-0 items-center gap-1.5", compact ? "w-[32%] min-w-24 max-w-48 shrink-0" : "flex-1")}>
      {showAccount && account ? (
        <span title={account.email} className="flex shrink-0">
          <ColorDot color={account.color} className="size-1.5" />
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
    <span className="flex min-w-0 flex-1 items-baseline gap-0 truncate">
      {thread.draftCount > 0 ? <span className="me-1.5 shrink-0 text-destructive-foreground text-xs font-medium">Draft</span> : null}
      <span className={cn("truncate", unread ? "font-semibold text-foreground" : "text-foreground/90")}>
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

  return (
    <div
      role="option"
      aria-selected={open}
      data-thread-id={thread.id}
      data-focused={focused || undefined}
      className={cn(
        "group/thread relative flex w-full cursor-pointer select-none items-center gap-2 border-border/50 border-b ps-2 pe-3 text-sm",
        compact ? "h-10" : "h-[68px]",
        open ? "bg-white/[0.075]" : checked ? "bg-primary/10" : "hover:bg-white/[0.035]",
        focused && "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ring)_75%,transparent)]",
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
            <span className="group-hover/thread:invisible">{date}</span>
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <span className="flex min-w-0 items-center gap-2">
            {peopleEl}
            <span className="group-hover/thread:invisible">{date}</span>
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
          compact ? "inset-y-0" : "top-1.5",
        )}
      >
        <span className={cn("flex items-center rounded-lg px-0.5", open ? "bg-[color-mix(in_srgb,#fff_7.5%,#000)]" : checked ? "bg-[color-mix(in_srgb,var(--primary)_10%,#000)]" : "bg-[color-mix(in_srgb,#fff_3.5%,#000)]")}>
          {quickActions}
        </span>
      </span>
    </div>
  );
});
