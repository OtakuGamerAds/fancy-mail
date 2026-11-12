/**
 * Settings, in place of the list and the reader: a left nav like T3 Code's settings and the
 * section on the right.
 */
import {
  BotIcon,
  BookOpenIcon,
  DatabaseIcon,
  FolderTreeIcon,
  InfoIcon,
  KeyRoundIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";

import { IconButton, ShowSidebarButton } from "~/components/common";
import { sidebarRowClass } from "~/components/sidebar/SidebarRow";
import { cn } from "~/lib/utils";
import { navigate, type SettingsSection } from "~/state/router";
import { useUi } from "~/state/ui";
import { AccountsSettings } from "./AccountsSettings";
import { AgentsSettings } from "./AgentsSettings";
import { GroupsLabelsSettings } from "./GroupsLabelsSettings";
import { AboutSettings, DataSettings, ReadingSettings, SignInSettings } from "./OtherSettings";

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "accounts", label: "Accounts", icon: UsersIcon },
  { id: "groups-labels", label: "Groups & labels", icon: FolderTreeIcon },
  { id: "agents", label: "Agents", icon: BotIcon },
  { id: "reading", label: "Reading", icon: BookOpenIcon },
  { id: "sign-in", label: "Google & Microsoft", icon: KeyRoundIcon },
  { id: "data", label: "Data", icon: DatabaseIcon },
  { id: "about", label: "About", icon: InfoIcon },
];

export function SettingsView({ section }: { section: SettingsSection }) {
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]!;
  return (
    <div className="flex h-full min-w-0 flex-1">
      <nav aria-label="Settings" className="flex w-[clamp(11.5rem,17vw,15rem)] shrink-0 flex-col border-border border-r px-2">
        <div data-drag-region className="app-drag flex h-[var(--header-height)] shrink-0 items-center gap-1 ps-2.5">
          <ShowSidebarButton />
          <h1 className="font-semibold text-[15px] tracking-tight">Settings</h1>
        </div>
        <div className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                data-active={s.id === section ? "true" : undefined}
                aria-current={s.id === section ? "page" : undefined}
                className={cn(sidebarRowClass, "h-auto min-h-8 py-1.5")}
                onClick={() => navigate({ page: "settings", section: s.id }, { replace: true })}
              >
                <Icon />
                <span className="min-w-0 flex-1 text-wrap leading-snug">{s.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          data-drag-region
          className="app-drag flex h-[var(--header-height)] shrink-0 items-center gap-2 ps-6"
          style={{ paddingInlineEnd: "calc(var(--wco-inset) + 0.75rem)" }}
        >
          <h2 className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-sm">{current.label}</h2>
          <IconButton
            label="Close settings"
            shortcut="Esc"
            onClick={() => navigate({ page: "mail", view: { kind: "inbox", scope: useUi.getState().scope }, threadId: null })}
          >
            <XIcon />
          </IconButton>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onKeyDown={(event) => {
            if (event.key === "Escape" && event.target === event.currentTarget) {
              navigate({ page: "mail", view: { kind: "inbox", scope: useUi.getState().scope }, threadId: null });
            }
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-2 pb-16 sm:px-6">
            {section === "accounts" ? <AccountsSettings /> : null}
            {section === "groups-labels" ? <GroupsLabelsSettings /> : null}
            {section === "agents" ? <AgentsSettings /> : null}
            {section === "reading" ? <ReadingSettings /> : null}
            {section === "sign-in" ? <SignInSettings /> : null}
            {section === "data" ? <DataSettings /> : null}
            {section === "about" ? <AboutSettings /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
