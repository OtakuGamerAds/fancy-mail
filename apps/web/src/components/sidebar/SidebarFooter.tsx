/**
 * The pinned footer: Activity (with a dot when an agent changed something since you last
 * looked), the agent line, Settings and — in the desktop app — the update button.
 */
import { HistoryIcon, SettingsIcon } from "lucide-react";

import { IconButton } from "~/components/common";
import { UpdateButton } from "~/components/sidebar/UpdateButton";
import { prettifyAgentName } from "~/lib/agents";
import { cn } from "~/lib/utils";
import { useLive } from "~/state/events";
import { useBootstrap } from "~/state/queries";
import { navigate } from "~/state/router";
import { useUi } from "~/state/ui";
import { sidebarRowClass } from "./SidebarRow";
import { isModKey } from "~/lib/keys";

export function SidebarFooter() {
  const { data: bootstrap } = useBootstrap();
  const latestAgentAt = useLive((s) => s.latestAgentActivityAt);
  const seenAt = useUi((s) => s.activitySeenAt);
  const routePage = useUi((s) => s.route.page);
  const setSheet = useUi((s) => s.setActivitySheetOpen);
  const mcp = bootstrap?.mcp;
  const clients = mcp?.clients ?? [];
  const unseen = latestAgentAt > seenAt;

  let agentLine: string;
  if (!mcp?.enabled) agentLine = "Agents are off";
  else if (clients.length === 0) agentLine = "No agent connected";
  else if (clients.length === 1) agentLine = `${prettifyAgentName(clients[0]!.name)} connected`;
  else agentLine = `${clients.length} agents connected`;

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-sidebar-border border-t px-[var(--sidebar-content-inset)] pt-1.5 pb-[var(--sidebar-content-inset)]">
      <button
        type="button"
        className={cn(sidebarRowClass, "h-7 text-xs font-normal")}
        onClick={() => navigate({ page: "settings", section: "agents" })}
        title="Settings › Agents"
      >
        <span className="grid size-4 shrink-0 place-items-center">
          <span
            className={cn(
              "size-2 rounded-full",
              clients.length > 0 && mcp?.enabled ? "bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_20%,transparent)]" : "bg-muted-foreground/40",
            )}
          />
        </span>
        <span className={cn("min-w-0 flex-1 truncate", clients.length > 0 && mcp?.enabled ? "text-sidebar-foreground/90" : "text-sidebar-muted-foreground/80")}>
          {agentLine}
        </span>
      </button>
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-active={routePage === "activity" ? "true" : undefined}
          className={cn(sidebarRowClass, "flex-1")}
          onClick={(event) => {
            // Ctrl-click (⌘ on a Mac) opens the full page; a plain click the side sheet.
            if (isModKey(event)) navigate({ page: "activity" });
            else setSheet(true);
          }}
        >
          <HistoryIcon />
          <span className="min-w-0 flex-1 truncate">Activity</span>
          {unseen ? <span aria-label="New agent activity" className="size-2 rounded-full bg-update-foreground" /> : null}
        </button>
        <UpdateButton />
        <IconButton
          label="Settings"
          shortcut="Ctrl+,"
          side="top"
          pressed={routePage === "settings"}
          onClick={() => navigate({ page: "settings", section: "accounts" })}
          className="rounded-full before:rounded-full"
        >
          <SettingsIcon />
        </IconButton>
      </div>
    </div>
  );
}
