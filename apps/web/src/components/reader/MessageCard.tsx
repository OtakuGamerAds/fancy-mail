/**
 * One message in the conversation, as a card in T3 Code's timeline style (the user-turn
 * surface, radius 16). Collapsed: a single line (sender · snippet · date); click to open.
 */
import type { AttachmentMeta, Message } from "@fancy-mail/contracts";
import {
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ForwardIcon,
  MoreHorizontalIcon,
  ReplyAllIcon,
  ReplyIcon,
} from "lucide-react";

import { PersonAvatar, WithTooltip } from "~/components/common";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { displayName, formatAddress } from "~/lib/addresses";
import { downloadAttachment, openAttachment } from "~/lib/desktop";
import { formatExact, formatRelative, formatSize } from "~/lib/format";
import { cn } from "~/lib/utils";
import type { Directory } from "~/state/queries";
import { useUi } from "~/state/ui";
import { EmailBody } from "./EmailBody";

function recipientLine(message: Message, dir: Directory): string {
  const people = [...message.to, ...message.cc];
  if (people.length === 0) return message.bcc.length > 0 ? "to undisclosed recipients" : "";
  const names = people.map((a) => (dir.ownAddresses.has(a.address.toLowerCase()) ? "me" : displayName(a).split(/\s+/)[0]!));
  // "me" first, the way people read it.
  names.sort((a, b) => (a === "me" ? -1 : b === "me" ? 1 : 0));
  const shown = names.slice(0, 2).join(", ");
  return `to ${shown}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
}

export function MessageCard({
  message,
  dir,
  expanded,
  onToggle,
  threadId,
  isLast,
}: {
  message: Message;
  dir: Directory;
  expanded: boolean;
  onToggle(): void;
  threadId: string;
  isLast: boolean;
}) {
  const sender = message.from;
  const name = displayName(sender);
  const address = sender?.address ?? "";
  const isMe = sender ? dir.ownAddresses.has(sender.address.toLowerCase()) : false;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex h-11 w-full cursor-pointer items-center gap-3 rounded-2xl px-4 text-left text-sm outline-none hover:bg-white/[0.035] focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PersonAvatar name={name} address={address} size={22} />
        <span className={cn("max-w-48 shrink-0 truncate", message.unread ? "font-semibold text-foreground" : "font-medium text-foreground/85")}>
          {isMe ? "me" : name}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{message.snippet}</span>
        <time className="shrink-0 text-muted-foreground text-xs tabular-nums" title={formatExact(message.date)}>
          {formatRelative(message.date)}
        </time>
      </button>
    );
  }

  const attachments = message.attachments.filter((a) => !a.inline);
  const ui = useUi.getState();

  return (
    <article className="rounded-2xl border border-white/[0.04] bg-message" aria-label={`Message from ${name}`}>
      <header className="flex items-start gap-3 px-4 pt-3.5 pb-2" onClick={isLast ? undefined : onToggle}>
        <PersonAvatar name={name} address={address} size={32} />
        <div className={cn("min-w-0 flex-1", !isLast && "cursor-pointer")}>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-semibold text-sm text-foreground" data-selectable>
              {name}
            </span>
            <span className="min-w-0 truncate text-muted-foreground text-xs" data-selectable title={sender ? formatAddress(sender) : undefined}>
              {address}
            </span>
          </div>
          <WithTooltip
            side="bottom"
            label={
              <span className="block space-y-0.5">
                {message.to.length > 0 ? <span className="block">To: {message.to.map(formatAddress).join(", ")}</span> : null}
                {message.cc.length > 0 ? <span className="block">Cc: {message.cc.map(formatAddress).join(", ")}</span> : null}
                {message.bcc.length > 0 ? <span className="block">Bcc: {message.bcc.map(formatAddress).join(", ")}</span> : null}
              </span>
            }
          >
            <span className="block truncate text-muted-foreground text-xs">{recipientLine(message, dir)}</span>
          </WithTooltip>
        </div>
        <time className="mt-0.5 shrink-0 text-muted-foreground text-xs tabular-nums" title={formatExact(message.date)}>
          {formatRelative(message.date)}
        </time>
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost-muted" size="icon-xs" aria-label="Message actions" className="-me-1.5 -mt-0.5" onClick={(e) => e.stopPropagation()} />}
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="w-44">
            <MenuItem onClick={() => ui.requestReply(threadId, "reply")}>
              <ReplyIcon />
              Reply
            </MenuItem>
            <MenuItem onClick={() => ui.requestReply(threadId, "replyAll")}>
              <ReplyAllIcon />
              Reply all
            </MenuItem>
            <MenuItem onClick={() => ui.requestReply(threadId, "forward")}>
              <ForwardIcon />
              Forward
            </MenuItem>
          </MenuPopup>
        </Menu>
      </header>
      <div className="px-4 pb-4">
        <EmailBody message={message} />
        {attachments.length > 0 ? <AttachmentList attachments={attachments} /> : null}
      </div>
    </article>
  );
}

function iconFor(attachment: AttachmentMeta) {
  const type = attachment.mimeType.toLowerCase();
  const name = attachment.filename.toLowerCase();
  if (type.startsWith("image/")) return FileImageIcon;
  if (type.startsWith("video/")) return FileVideoIcon;
  if (type.startsWith("audio/")) return FileAudioIcon;
  if (/zip|compressed|tar|rar|7z/.test(type) || /\.(zip|rar|7z|tar|gz)$/.test(name)) return FileArchiveIcon;
  if (/sheet|excel|csv/.test(type) || /\.(xlsx?|csv|ods)$/.test(name)) return FileSpreadsheetIcon;
  if (type === "application/pdf" || type.startsWith("text/") || /word|document/.test(type)) return FileTextIcon;
  return FileIcon;
}

function AttachmentList({ attachments }: { attachments: AttachmentMeta[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const Icon = iconFor(attachment);
        return (
          <div
            key={attachment.id}
            className="group/att flex h-11 max-w-72 items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.03] ps-3 pe-1 hover:bg-white/[0.06]"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left outline-none"
              onClick={() => openAttachment(attachment.id, attachment.filename)}
              title={`Open ${attachment.filename}`}
            >
              <Icon className="size-4.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-foreground/90">{attachment.filename}</span>
                <span className="block text-muted-foreground text-xs tabular-nums">{formatSize(attachment.size)}</span>
              </span>
            </button>
            <button
              type="button"
              aria-label={`Download ${attachment.filename}`}
              title="Download"
              onClick={() => downloadAttachment(attachment.id, attachment.filename)}
              className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground opacity-70 hover:bg-white/10 hover:text-foreground group-hover/att:opacity-100"
            >
              <DownloadIcon className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
