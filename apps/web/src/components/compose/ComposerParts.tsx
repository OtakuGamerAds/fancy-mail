/** Pieces both composers share: the attachment chips, the attach button, the quote fold. */
import type { DraftAttachment } from "@fancy-mail/contracts";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { IconButton } from "~/components/common";
import { Spinner } from "~/components/ui/spinner";
import { formatSize } from "~/lib/format";
import { cn } from "~/lib/utils";
import type { DraftEditor } from "./useDraftEditor";

/** T3 Code's composer surface (ComposerSurface.tsx): raised card, faint outline, top highlight. */
export const COMPOSER_SURFACE =
  "relative rounded-2xl border border-(--composer-outline) bg-card inset-shadow-2xs inset-shadow-(color:--composer-highlight)";

export function AttachButton({ editor, side = "top" }: { editor: DraftEditor; side?: "top" | "bottom" }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) void editor.attach(event.target.files);
          event.target.value = "";
        }}
      />
      <IconButton label="Attach files" side={side} onClick={() => input.current?.click()} className="rounded-full before:rounded-full">
        <PaperclipIcon />
      </IconButton>
    </>
  );
}

export function AttachmentChips({ editor, className }: { editor: DraftEditor; className?: string }) {
  const { attachments } = editor.fields;
  if (attachments.length === 0 && editor.uploading.length === 0) return null;
  const remove = (attachment: DraftAttachment) =>
    editor.update({ attachments: editor.fields.attachments.filter((a) => a.id !== attachment.id) });
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg bg-white/[0.06] ps-2 pe-0.5 text-xs"
          title={attachment.filename}
        >
          <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{attachment.filename}</span>
          <span className="shrink-0 text-muted-foreground tabular-nums">{formatSize(attachment.size)}</span>
          <button
            type="button"
            aria-label={`Remove ${attachment.filename}`}
            onClick={() => remove(attachment)}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      {editor.uploading.map((file) => (
        <span key={file.key} className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-lg bg-white/[0.04] px-2 text-muted-foreground text-xs">
          <Spinner size="xs" />
          <span className="truncate">{file.name}</span>
        </span>
      ))}
    </div>
  );
}

/** The quoted or forwarded original, folded under "···" (it is sent below what you write). */
export function QuoteFold({ editor }: { editor: DraftEditor }) {
  const [open, setOpen] = useState(false);
  const quote = editor.fields.quote;
  if (!quote) return null;
  const isForward = editor.fields.mode === "forward";
  return (
    <div className="px-3 pb-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? "Hide the quoted message" : "Show the quoted message"}
          className="inline-flex h-5 cursor-pointer items-center rounded-full bg-white/[0.06] px-2 text-muted-foreground text-xs leading-none hover:bg-white/10 hover:text-foreground"
        >
          ···
        </button>
        {!isForward ? (
          <button
            type="button"
            onClick={() => editor.update({ quote: null })}
            className="cursor-pointer px-1 text-muted-foreground/80 text-xs hover:text-foreground"
          >
            Remove quote
          </button>
        ) : null}
      </div>
      {open ? (
        <pre className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap border-border border-l-2 ps-3 font-sans text-muted-foreground text-xs leading-relaxed" data-selectable>
          {quote}
        </pre>
      ) : null}
    </div>
  );
}

export function SaveStatus({ editor }: { editor: DraftEditor }) {
  const text =
    editor.saveState === "saving" ? "Saving…" : editor.saveState === "saved" ? "Draft saved" : editor.saveState === "error" ? "Not saved" : "";
  return (
    <span
      aria-live="polite"
      className={cn("min-w-0 truncate text-xs", editor.saveState === "error" ? "text-destructive-foreground" : "text-muted-foreground/80")}
    >
      {text}
    </span>
  );
}
