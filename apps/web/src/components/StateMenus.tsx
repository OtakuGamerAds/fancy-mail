/**
 * Choosing when a waiting or snoozed conversation comes back: the usual times in a menu, and
 * "Pick a time…" for any other (a small dialog, opened from anywhere through a promise, as
 * T3 Code's custom snooze).
 */
import { HourglassIcon } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";

import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Menu, MenuGroupLabel, MenuItem, MenuItemDetail, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { formatWhen, snoozeChoices, waitChoices } from "~/lib/stateTimes";

export type TimedKind = "wait" | "snooze";

export const TIMED_COPY: Record<TimedKind, { menuTitle: string; dialogTitle: string; description: string; confirm: string }> = {
  wait: {
    menuTitle: "Wait for an answer",
    dialogTitle: "Wait for an answer until",
    description: "It leaves your list. An answer brings it back at once; with none by then, it comes back as No reply.",
    confirm: "Wait",
  },
  snooze: {
    menuTitle: "Snooze until",
    dialogTitle: "Snooze until",
    description: "It leaves your list and comes back then, or sooner if new mail comes.",
    confirm: "Snooze",
  },
};

/** The usual times, then "Pick a time…". */
export function TimeMenuItems({ kind, onPick }: { kind: TimedKind; onPick(until: number): void }) {
  const choices = kind === "wait" ? waitChoices() : snoozeChoices();
  return (
    <>
      {choices.map((choice) => (
        <MenuItem key={choice.id} onClick={() => onPick(choice.until)}>
          {choice.label}
          <MenuItemDetail>{choice.detail}</MenuItemDetail>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onClick={() => void requestCustomTime(kind).then((until) => until !== null && onPick(until))}>Pick a time…</MenuItem>
    </>
  );
}

/**
 * Beside Send: send, and wait for the answer (the conversation leaves your list until it comes,
 * or until the time to follow up).
 */
export function SendAndWaitButton({ disabled, onSend, round }: { disabled: boolean; onSend(until: number): void; round?: boolean }) {
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Send and wait for an answer"
            title="Send and wait for an answer"
            className={cn(round && "rounded-full before:rounded-full")}
          />
        }
      >
        <HourglassIcon />
      </MenuTrigger>
      <MenuPopup side="top" align="end" className="w-64">
        <MenuGroupLabel>Send, and wait for an answer</MenuGroupLabel>
        <TimeMenuItems kind="wait" onPick={onSend} />
      </MenuPopup>
    </Menu>
  );
}

// ── "Pick a time…" ──────────────────────────────────────────────────────────────────────────

interface CustomTimeState {
  request: { kind: TimedKind; resolve(until: number | null): void } | null;
}

const useCustomTime = create<CustomTimeState>(() => ({ request: null }));

/** Asks for a time; null when cancelled. */
export function requestCustomTime(kind: TimedKind): Promise<number | null> {
  return new Promise((resolve) => {
    useCustomTime.getState().request?.resolve(null);
    useCustomTime.setState({ request: { kind, resolve } });
  });
}

/** "2026-11-26T09:00" for a datetime-local input, in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultTime(kind: TimedKind): number {
  const d = new Date();
  d.setDate(d.getDate() + (kind === "wait" ? 7 : 1));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** Mounted once (App). */
export function CustomTimeDialogHost() {
  const request = useCustomTime((s) => s.request);
  return request ? <CustomTimeDialog key={request.kind + String(Date.now())} kind={request.kind} resolve={request.resolve} /> : null;
}

function CustomTimeDialog({ kind, resolve }: { kind: TimedKind; resolve(until: number | null): void }) {
  const [value, setValue] = useState(() => toLocalInput(defaultTime(kind)));
  const until = new Date(value).getTime();
  const valid = Number.isFinite(until) && until > Date.now();
  const copy = TIMED_COPY[kind];
  const finish = (result: number | null) => {
    useCustomTime.setState({ request: null });
    resolve(result);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && finish(null)}>
      <DialogPopup className="max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) finish(until);
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.dialogTitle}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <Input type="datetime-local" value={value} min={toLocalInput(Date.now())} onChange={(event) => setValue(event.target.value)} autoFocus />
            <p className="text-muted-foreground text-xs">{valid ? formatWhen(until) : "Choose a time in the future."}</p>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              {copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
