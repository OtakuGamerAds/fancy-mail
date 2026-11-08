/**
 * Label conversations: a filter field and every label with its state for the chosen
 * conversations (on, off, on some). Clicking applies at once; typing a new name offers
 * "Create". Used from the bulk bar, the reader, and the `l` key (as a small dialog).
 */
import type { ThreadSummary } from "@fancy-mail/contracts";
import { MinusIcon, PlusIcon, SearchIcon, TagIcon } from "lucide-react";
import { useMemo, useRef, useState, type ReactElement } from "react";

import { ColorDot } from "~/components/common";
import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn, normalizeSearchText } from "~/lib/utils";
import { createLabel, modifyThreads } from "~/state/actions";
import { listNav } from "~/state/listNav";
import { findCachedThread, useDirectory } from "~/state/queries";
import { useUi } from "~/state/ui";

type State = "on" | "off" | "some";

function threadsFor(ids: string[]): ThreadSummary[] {
  const byId = new Map(listNav.threads.map((t) => [t.id, t]));
  return ids.map((id) => findCachedThread(id) ?? byId.get(id)).filter((t): t is ThreadSummary => !!t);
}

export function LabelPickerContent({ threadIds, onDone }: { threadIds: string[]; onDone?: () => void }) {
  const dir = useDirectory();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  // Re-read on every render: toggles change the cache optimistically.
  const threads = threadsFor(threadIds);
  const listRef = useRef<HTMLDivElement>(null);

  const stateOf = (labelId: string): State => {
    if (threads.length === 0) return "off";
    const count = threads.filter((t) => t.labelIds.includes(labelId)).length;
    return count === 0 ? "off" : count === threads.length ? "on" : "some";
  };

  const query = normalizeSearchText(text);
  const labels = useMemo(
    () => dir.labels.filter((l) => !query || normalizeSearchText(l.name).includes(query)),
    [dir.labels, query],
  );
  const exact = dir.labels.some((l) => normalizeSearchText(l.name) === query);
  const canCreate = text.trim().length > 0 && !exact;
  const itemCount = labels.length + (canCreate ? 1 : 0);

  const toggle = (labelId: string) => {
    const state = stateOf(labelId);
    void modifyThreads(threadIds, [state === "on" ? { type: "removeLabels", labelIds: [labelId] } : { type: "addLabels", labelIds: [labelId] }]);
  };

  const create = async () => {
    const name = text.trim();
    if (!name) return;
    const label = await createLabel(name);
    if (label) {
      void modifyThreads(threadIds, [{ type: "addLabels", labelIds: [label.id] }]);
      setText("");
    }
  };

  const activate = (index: number) => {
    if (index < labels.length) toggle(labels[index]!.id);
    else if (canCreate) void create();
  };

  return (
    <div className="flex w-64 flex-col">
      <div className="px-2 pt-1.5 pb-1">
        <div className="relative border-border/70 border-b pb-1.5 transition-colors focus-within:border-ring">
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1.5 left-0 size-4 text-muted-foreground/55" />
          <input
            autoFocus
            value={text}
            placeholder="Label as…"
            aria-label="Filter labels"
            className="h-6.5 w-full bg-transparent ps-6 text-sm leading-6.5 outline-none placeholder:text-placeholder"
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((a) => Math.min(itemCount - 1, a + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(active);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onDone?.();
              }
            }}
          />
        </div>
      </div>
      <div ref={listRef} role="listbox" aria-multiselectable className="max-h-72 overflow-y-auto p-1">
        {labels.map((label, index) => {
          const state = stateOf(label.id);
          return (
            <button
              key={label.id}
              type="button"
              role="option"
              aria-selected={state === "on"}
              data-highlighted={index === active || undefined}
              onMouseMove={() => setActive(index)}
              onClick={() => toggle(label.id)}
              className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-sm outline-none data-highlighted:bg-accent"
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-[.25rem] border",
                  state === "off" ? "border-input" : "border-primary bg-primary text-primary-foreground",
                )}
              >
                {state === "on" ? (
                  <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
                  </svg>
                ) : state === "some" ? (
                  <MinusIcon className="size-3" strokeWidth={3} />
                ) : null}
              </span>
              <ColorDot color={label.color} />
              <span className="min-w-0 flex-1 truncate">{label.name}</span>
            </button>
          );
        })}
        {canCreate ? (
          <button
            type="button"
            data-highlighted={active === labels.length || undefined}
            onMouseMove={() => setActive(labels.length)}
            onClick={() => void create()}
            className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-sm outline-none data-highlighted:bg-accent"
          >
            <PlusIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              Create “<span className="font-medium">{text.trim()}</span>”
            </span>
          </button>
        ) : null}
        {labels.length === 0 && !canCreate ? (
          <div className="flex items-center gap-2 px-2 py-3 text-muted-foreground text-sm">
            <TagIcon className="size-4" />
            Type a name to create a label.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The picker in a popover under a trigger (bulk bar, reader). */
export function LabelPickerPopover({ threadIds, trigger, side = "bottom", align = "end" }: { threadIds: string[]; trigger: ReactElement; side?: "bottom" | "top"; align?: "start" | "end" | "center" }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverPopup side={side} align={align} padding="none">
        {open ? <LabelPickerContent threadIds={threadIds} onDone={() => setOpen(false)} /> : null}
      </PopoverPopup>
    </Popover>
  );
}

/** The `l` key: the picker on its own, in the middle of the window. */
export function LabelPickerDialog() {
  const ids = useUi((s) => s.labelPickerFor);
  const close = useUi((s) => s.closeLabelPicker);
  return (
    <Dialog open={!!ids} onOpenChange={(open) => !open && close()}>
      <DialogPopup showCloseButton={false} className="w-auto max-w-none overflow-hidden p-0">
        {ids ? <LabelPickerContent threadIds={ids} onDone={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}
