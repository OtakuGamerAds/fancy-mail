/**
 * The update button beside Settings, after T3 Code's sidebar update control (components/
 * sidebar/DesktopUpdateStatusIcon.tsx and desktopUpdate.logic.ts, MIT License — see
 * THIRD_PARTY_LICENSE_T3CODE.txt) as Fancy Dictator adapted it. Always there in the installed
 * app: idle it checks for updates (spinning while it does); with an update it fills, a click
 * downloads (a ring shows the progress), and once downloaded a click restarts into it.
 * A new version also says so once, in a notice with the same button.
 */
import { CheckIcon, DownloadIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { toast } from "~/components/ui/toast";
import { bridge, type UpdateState } from "~/lib/desktop";
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

type Phase = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

function phaseOf(state: UpdateState): Phase {
  switch (state.status) {
    case "checking":
      return "checking";
    case "available":
      return "available";
    case "downloading":
      return "downloading";
    case "ready":
    case "downloaded":
      return "ready";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function versionOf(state: UpdateState): string | null {
  return state.version ?? state.downloadedVersion ?? state.availableVersion ?? null;
}

function percentOf(state: UpdateState): number | null {
  return state.percent ?? state.downloadPercent ?? null;
}

function label(state: UpdateState): string {
  const version = versionOf(state);
  switch (phaseOf(state)) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return state.message ? `${state.message} Click to try again.` : `Update ${version ?? ""} available. Click to download.`.replace("  ", " ");
    case "downloading": {
      const percent = percentOf(state);
      return `Downloading update${percent !== null ? ` (${Math.floor(percent)}%)` : ""}`;
    }
    case "ready":
      return `Update ${version ?? ""} downloaded. Click to restart into it.`.replace("  ", " ");
    case "error":
      return `${state.message ?? "Couldn't check for updates."} Click to try again.`;
    default:
      return state.status === "up-to-date" ? "You're up to date. Click to check again." : "Check for updates";
  }
}

/** A check the person asked for: its answer is said even when there is nothing new. */
let manualCheck = false;

function act(state: UpdateState): void {
  const update = bridge()?.update;
  if (!update) return;
  const phase = phaseOf(state);
  if (phase === "available") void update.download();
  else if (phase === "ready") void update.install();
  else if (phase !== "checking" && phase !== "downloading") {
    manualCheck = true;
    void update.check();
  }
}

export function UpdateButton() {
  const state = useUpdateState();
  // Updates only run in the installed app; from source there is nothing to show.
  if (!state || state.status === "disabled" || state.enabled === false) return null;

  const phase = phaseOf(state);
  const busy = phase === "checking" || phase === "downloading";
  const showsUpdate = phase === "available" || phase === "downloading" || phase === "ready";
  const text = label(state);

  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      aria-disabled={busy || undefined}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
        busy ? "cursor-default" : "cursor-pointer",
        showsUpdate
          ? cn("bg-muted text-foreground", !busy && "hover:bg-accent")
          : cn("text-sidebar-muted-foreground", !busy && "hover:bg-sidebar-row-hover hover:text-sidebar-foreground"),
      )}
      onClick={() => {
        if (!busy) act(state);
      }}
    >
      {phase === "available" ? (
        <span className="relative grid size-4 place-items-center">
          <DownloadIcon className="size-4" />
          <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-update-foreground ring-2 ring-background" />
        </span>
      ) : phase === "downloading" ? (
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
              strokeDashoffset={CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, percentOf(state) ?? 0)) / 100)}
              strokeLinecap="round"
              strokeWidth="1.5"
              className="transition-[stroke-dashoffset] duration-300 ease-out"
            />
          </svg>
          <DownloadIcon className="size-3.5" />
        </span>
      ) : phase === "ready" ? (
        <span className="relative grid size-4 place-items-center">
          <RotateCwIcon className="size-4" />
          <span className="absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full bg-foreground text-background ring-2 ring-background">
            <CheckIcon className="size-2" strokeWidth={3} />
          </span>
        </span>
      ) : (
        <RefreshCwIcon aria-hidden className={cn("size-4", phase === "checking" && "motion-safe:animate-spin")} />
      )}
    </button>
  );
}

/**
 * A notice when an update shows up, and when it is downloaded: once per version, with the
 * button's own action. Mounted once (App), so it works with the sidebar hidden too.
 */
export function useUpdateNotices(): void {
  const state = useUpdateState();
  const told = useRef(new Set<string>());
  useEffect(() => {
    if (!state || state.status === "disabled") return;
    const phase = phaseOf(state);
    const version = versionOf(state) ?? "";
    if (phase === "available" && !state.message && !told.current.has(`available:${version}`)) {
      told.current.add(`available:${version}`);
      toast.show({
        id: "update",
        type: "info",
        title: `Fancy Mail ${version} is available`,
        description: "Your mail and accounts stay as they are.",
        duration: 0,
        actions: [{ label: "Update", primary: true, onClick: () => void bridge()?.update?.download() }],
      });
    } else if (manualCheck && (state.status === "up-to-date" || phase === "error")) {
      manualCheck = false;
      if (phase === "error") toast.error("Couldn't check for updates", state.message ?? undefined);
      else toast.show({ id: "update", type: "success", title: "You're up to date", description: `Fancy Mail ${state.currentVersion ?? ""}`.trim(), duration: 3000 });
    } else if (phase === "ready" && !told.current.has(`ready:${version}`)) {
      told.current.add(`ready:${version}`);
      toast.show({
        id: "update",
        type: "success",
        title: `Fancy Mail ${version} is ready`,
        description: "Restart to use it. It takes a few seconds.",
        duration: 0,
        actions: [{ label: "Restart now", primary: true, onClick: () => void bridge()?.update?.install() }],
      });
    }
  }, [state]);
}
