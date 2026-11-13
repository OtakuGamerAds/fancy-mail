/**
 * Ctrl+K: T3 Code's command palette look (components/ui/command.tsx: the glass dialog, the
 * large search field, grouped rows, the footer of key hints; MIT License — see
 * THIRD_PARTY_LICENSE_T3CODE.txt). First row searches all mail for the text; then places to go,
 * actions, and live conversation matches.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ActivityIcon,
  ArchiveIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  FlaskConicalIcon,
  InboxIcon,
  KeyboardIcon,
  MailIcon,
  MailsIcon,
  OctagonAlertIcon,
  PanelRightIcon,
  PaperclipIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SquarePenIcon,
  StarIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { UNGROUPED_ID, VIEW_KINDS, VIEW_TITLES, type ViewKind } from "@fancy-mail/contracts";
import { AccountAvatar, ColorDot } from "~/components/common";
import { removeDemoMail } from "~/components/list/DemoBanner";
import { DIALOG_BACKDROP_CLASS, DIALOG_POPUP_CLASS } from "~/components/ui/dialog-styles";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { useDebounced } from "~/hooks/useDebounced";
import { formatListDate } from "~/lib/format";
import { cn, normalizeSearchText } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControls";
import { syncNow, updateSettings } from "~/state/actions";
import { useBootstrap, useDirectory, useQuickSearch } from "~/state/queries";
import { navigate, type Route } from "~/state/router";
import { useUi } from "~/state/ui";
import { participantsText } from "~/components/list/ThreadRow";
import { shortcutLabel } from "~/lib/keys";

interface PaletteItem {
  id: string;
  group: "Search" | "Go to" | "Actions" | "Conversations";
  title: ReactNode;
  /** Text the filter matches. */
  text: string;
  detail?: ReactNode;
  icon: ReactNode;
  shortcut?: string;
  run(): void;
}

const VIEW_ICONS: Record<ViewKind, LucideIcon> = {
  inbox: InboxIcon,
  unread: MailIcon,
  starred: StarIcon,
  drafts: FileTextIcon,
  sent: SendIcon,
  archive: ArchiveIcon,
  all: MailsIcon,
  attachments: PaperclipIcon,
  spam: OctagonAlertIcon,
  trash: Trash2Icon,
};

function go(route: Route) {
  navigate(route);
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const session = useUi((s) => s.paletteSession);
  const close = useUi((s) => s.closePalette);
  const titlebar = useNativeTitlebarHeight();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className={DIALOG_BACKDROP_CLASS} />
        <DialogPrimitive.Viewport
          className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 pb-[max(1rem,4vh)]"
          style={{ paddingTop: `max(10vh, ${titlebar + 8}px)` }}
        >
          <DialogPrimitive.Popup
            className={cn(DIALOG_POPUP_CLASS, "pointer-events-auto max-h-[min(30rem,80vh)] max-w-xl overflow-hidden text-foreground")}
            aria-label="Search and commands"
          >
            {open ? <PaletteBody key={session} onClose={close} /> : null}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaletteBody({ onClose }: { onClose(): void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const dir = useDirectory();
  const { data: bootstrap } = useBootstrap();
  const debounced = useDebounced(text, 120);
  const search = useQuickSearch(debounced);
  const listRef = useRef<HTMLDivElement>(null);
  const q = normalizeSearchText(text);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const trimmed = text.trim();
    const matches = (value: string) => !q || normalizeSearchText(value).includes(q);

    if (trimmed) {
      out.push({
        id: "search",
        group: "Search",
        title: (
          <span className="truncate">
            Search mail for “<span className="font-medium">{trimmed}</span>”
          </span>
        ),
        text: trimmed,
        icon: <SearchIcon />,
        // The same search as the sidebar's field: it stays on, narrowing every view, until cleared.
        run: () => {
          useUi.getState().setSearch(trimmed);
          go({ page: "mail", view: { kind: "inbox", scope: { type: "all" } }, threadId: null });
        },
      });
    }

    // Go to: views, groups, accounts, labels.
    const goItems: PaletteItem[] = [];
    for (const kind of VIEW_KINDS) {
      const Icon = VIEW_ICONS[kind];
      goItems.push({
        id: `view:${kind}`,
        group: "Go to",
        title: VIEW_TITLES[kind],
        text: VIEW_TITLES[kind],
        icon: <Icon />,
        run: () => go({ page: "mail", view: { kind, scope: useUi.getState().scope }, threadId: null }),
      });
    }
    for (const group of dir.groups) {
      goItems.push({
        id: `group:${group.id}`,
        group: "Go to",
        title: group.name,
        detail: "Group",
        text: `${group.name} group`,
        icon: <ColorDot color={group.color} className="mx-1" />,
        run: () => go({ page: "mail", view: { kind: "inbox", scope: { type: "group", groupId: group.id } }, threadId: null }),
      });
    }
    if (dir.groups.length > 0 && dir.accounts.some((a) => a.groupId === null || !dir.groupById.has(a.groupId))) {
      goItems.push({
        id: "group:ungrouped",
        group: "Go to",
        title: "Ungrouped",
        detail: "Accounts in no group",
        text: "ungrouped no group accounts",
        icon: <ColorDot color={null} className="mx-1" />,
        run: () => go({ page: "mail", view: { kind: "inbox", scope: { type: "group", groupId: UNGROUPED_ID } }, threadId: null }),
      });
    }
    for (const account of dir.accounts) {
      goItems.push({
        id: `account:${account.id}`,
        group: "Go to",
        title: account.displayName || account.email,
        detail: account.email,
        text: `${account.displayName} ${account.email}`,
        icon: <AccountAvatar account={account} size={16} />,
        run: () => go({ page: "mail", view: { kind: "inbox", scope: { type: "account", accountId: account.id } }, threadId: null }),
      });
    }
    for (const label of dir.labels) {
      goItems.push({
        id: `label:${label.id}`,
        group: "Go to",
        title: label.name,
        detail: "Label",
        text: `${label.name} label`,
        icon: <ColorDot color={label.color} className="mx-1" />,
        run: () => go({ page: "mail", view: { kind: "label", labelId: label.id, scope: useUi.getState().scope }, threadId: null }),
      });
    }
    const goShown = goItems.filter((i) => matches(i.text));
    out.push(...(q ? goShown.slice(0, 8) : goShown.slice(0, 5)));

    const readingPane = bootstrap?.settings.readingPane ?? "right";
    const actions: PaletteItem[] = [
      { id: "a:compose", group: "Actions", title: "New message", text: "new message compose write", icon: <SquarePenIcon />, shortcut: "C", run: () => useUi.getState().openCompose() },
      { id: "a:add", group: "Actions", title: "Add account", text: "add account", icon: <PlusIcon />, run: () => useUi.getState().openDialog({ type: "add-account" }) },
      { id: "a:settings", group: "Actions", title: "Settings", text: "settings preferences", icon: <SettingsIcon />, shortcut: shortcutLabel("Ctrl+,"), run: () => go({ page: "settings", section: "accounts" }) },
      { id: "a:agents", group: "Actions", title: "Agents and MCP", text: "agents mcp claude settings", icon: <SettingsIcon />, run: () => go({ page: "settings", section: "agents" }) },
      { id: "a:activity", group: "Actions", title: "Activity", text: "activity history undo", icon: <ActivityIcon />, run: () => go({ page: "activity" }) },
      {
        id: "a:pane",
        group: "Actions",
        title: readingPane === "right" ? "Turn off the reading pane" : "Show the reading pane",
        text: "toggle reading pane",
        icon: <PanelRightIcon />,
        run: () => void updateSettings({ readingPane: readingPane === "right" ? "off" : "right" }),
      },
      { id: "a:sync", group: "Actions", title: "Sync all accounts", text: "sync all refresh", icon: <RefreshCwIcon />, run: () => syncNow() },
      { id: "a:keys", group: "Actions", title: "Keyboard shortcuts", text: "keyboard shortcuts keys", icon: <KeyboardIcon />, shortcut: "?", run: () => useUi.getState().openDialog({ type: "shortcuts" }) },
    ];
    if (bootstrap?.hasDemoData) {
      actions.push({ id: "a:demo", group: "Actions", title: "Remove demo mail", text: "remove demo mail", icon: <FlaskConicalIcon />, run: () => void removeDemoMail() });
    }
    out.push(...actions.filter((a) => matches(`${a.text} ${typeof a.title === "string" ? a.title : ""}`)));

    if (trimmed && debounced.trim() === trimmed) {
      for (const thread of search.data?.threads ?? []) {
        const account = dir.accountById.get(thread.accountId);
        out.push({
          id: `thread:${thread.id}`,
          group: "Conversations",
          title: (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={cn("max-w-40 shrink-0 truncate", thread.unreadCount > 0 && "font-semibold")}>{participantsText(thread, dir)}</span>
              <span className="min-w-0 truncate text-muted-foreground">{thread.subject || "(no subject)"}</span>
            </span>
          ),
          text: thread.subject,
          detail: formatListDate(thread.lastMessageAt),
          icon: account ? <ColorDot color={account.color} className="mx-1" /> : <MailIcon />,
          run: () => {
            const route = useUi.getState().route;
            const view = route.page === "mail" ? route.view : { kind: "all" as const, scope: { type: "all" as const } };
            go({ page: "mail", view, threadId: thread.id });
          },
        });
      }
    }
    return out;
  }, [text, q, dir, bootstrap, search.data, debounced]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    // After the dialog lets go of focus.
    setTimeout(() => item.run(), 0);
  };

  let lastGroup: string | null = null;

  return (
    <div className="flex max-h-[inherit] min-h-0 flex-col">
      <div className="px-[var(--command-shell-inset)] py-1.5">
        <div className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-3 size-4 text-icon-muted opacity-80" />
          <input
            autoFocus
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((a) => (items.length === 0 ? 0 : (a + 1) % items.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((a) => (items.length === 0 ? 0 : (a - 1 + items.length) % items.length));
              } else if (event.key === "Enter") {
                event.preventDefault();
                runItem(items[active]);
              }
            }}
            placeholder="Search mail, go to, or run a command"
            aria-label="Search and commands"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${items[active]!.id}` : undefined}
            role="combobox"
            aria-expanded
            spellCheck={false}
            className="h-9.5 w-full bg-transparent ps-9.5 pe-9 text-base leading-9.5 outline-none placeholder:text-placeholder sm:h-8.5 sm:text-sm sm:leading-8.5"
          />
          {search.isFetching && text.trim() ? <Spinner size="sm" tone="muted" className="absolute right-3" /> : null}
        </div>
      </div>
      <div ref={listRef} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto border-foreground/[0.07] border-t p-2">
        {items.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-sm">Nothing matches.</div>
        ) : (
          items.map((item, index) => {
            const header = item.group !== lastGroup && item.group !== "Search" ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header ? <div className={cn("px-2 py-1.5 font-medium text-muted-foreground text-xs", index > 0 && "mt-1.5")}>{header}</div> : null}
                <div
                  id={`palette-${item.id}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  data-highlighted={index === active || undefined}
                  onMouseMove={() => index !== active && setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => runItem(item)}
                  className="flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-highlighted:bg-foreground/[0.09] [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"
                >
                  <span className="flex w-4 shrink-0 items-center justify-center">{item.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                  {item.detail ? <span className="max-w-[40%] shrink-0 truncate text-muted-foreground/80 text-xs">{item.detail}</span> : null}
                  {item.shortcut ? <span className="ms-2 shrink-0 font-medium text-secondary-label text-xs tracking-widest">{item.shortcut}</span> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-foreground/[0.07] border-t bg-foreground/[0.025] px-[var(--command-content-inset)] py-2.5 font-medium text-muted-foreground text-xs [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </KbdGroup>
            Move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>
              <CornerDownLeftIcon />
            </Kbd>
            Open
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          Close
        </span>
      </div>
    </div>
  );
}

