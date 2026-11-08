/**
 * The update button beside Settings, after T3 Code's sidebar update control (components/
 * sidebar/DesktopUpdateStatusIcon.tsx, MIT License — see THIRD_PARTY_LICENSE_T3CODE.txt) as
 * Fancy Dictator adapted it. Hidden unless an update exists; a ring shows the download.
 */
import { CheckIcon, DownloadIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { bridge, describeUpdate, type UpdateState } from "~/lib/desktop";
import { cn } from "~/lib/utils";

const RADIUS = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const update = bridge()?.update;
    if (!update) return;
    let alive = true;
    void update
      .state()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {});
    const off = update.onState((s) => setState(s));
    return () => {
      alive = false;
      if (typeof off === "function") off();
    };
  }, []);
  return state;
}

export function UpdateButton() {
  const state = useUpdateState();
  const info = describeUpdate(state);
  if (!info.visible) return null;

  const label =
    info.phase === "available"
      ? `Update ${info.version ?? ""} available. Click to download.`.replace("  ", " ")
      : info.phase === "downloading"
        ? `Downloading update${info.percent !== null ? ` (${Math.floor(info.percent)}%)` : ""}`
        : `Update ${info.version ?? ""} downloaded. Click to restart and install.`.replace("  ", " ");
  const busy = info.phase === "downloading";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-disabled={busy || undefined}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        busy ? "cursor-default" : "cursor-pointer hover:bg-accent",
      )}
      onClick={() => {
        const update = bridge()?.update;
        if (!update || busy) return;
        if (info.phase === "available") void update.download();
        else if (info.phase === "ready") void update.install();
      }}
    >
      {info.phase === "available" ? (
        <span className="relative grid size-4 place-items-center">
          <DownloadIcon className="size-4" />
          <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-update-foreground ring-2 ring-background" />
        </span>
      ) : info.phase === "downloading" ? (
        <span className="relative grid size-7 place-items-center">
          <svg aria-hidden className="pointer-events-none absolute inset-0 size-full -rotate-90" viewBox="0 0 32 32">
            <circle cx="16" cy="16" r={RADIUS} fill="none" className="stroke-current/22" strokeWidth="1.5" />
            <circle
              cx="16"
              cy="16"
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, info.percent ?? 0)) / 100)}
              strokeLinecap="round"
              strokeWidth="1.5"
              className="transition-[stroke-dashoffset] duration-300 ease-out"
            />
          </svg>
          <DownloadIcon className="size-3.5" />
        </span>
      ) : (
        <span className="relative grid size-4 place-items-center">
          <RotateCwIcon className="size-4" />
          <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
            <CheckIcon className="size-2" strokeWidth={3} />
          </span>
        </span>
      )}
    </button>
  );
}
