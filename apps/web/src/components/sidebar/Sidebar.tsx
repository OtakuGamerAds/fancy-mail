/**
 * The sidebar, after T3 Code's (components/Sidebar.tsx and ui/sidebar.tsx, MIT License — see
 * THIRD_PARTY_LICENSE_T3CODE.txt): New message and the search field on top; Mail, Groups and
 * Labels sections that collapse; a pinned footer with Activity, the agent line and Settings.
 * While a search is on, groups, accounts and labels count their matches (the rest fade).
 */
import { scopeHas, UNGROUPED_ID, type Account, type Group, type Label, type ScopeItem, type ViewKind } from "@fancy-mail/contracts";
import {
  ArchiveIcon,
  LayersIcon,
  ChevronRightIcon,
  FileTextIcon,
  InboxIcon,
  MailIcon,
  MailsIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  OctagonAlertIcon,
  PaperclipIcon,
  PlusIcon,
  SendIcon,
  SquarePenIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  FolderIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { AccountAvatar, AccountStatusMark, ColorDot } from "~/components/common";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { Kbd } from "~/components/ui/kbd";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { createGroup, createLabel, updateAccount, updateGroup, updateLabel } from "~/state/actions";
import { useBootstrap, useDirectory, useDrafts } from "~/state/queries";
import { navigate, viewKey, type ViewRef } from "~/state/router";
import { goScope, MULTI_CLICK, pickScope, useScope } from "~/state/scope";
import { scopeAccounts, scopeLabel } from "~/state/view";
import { openAccountSettings } from "~/components/settings/AccountsSettings";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useUi } from "~/state/ui";
import { useColumnResize } from "~/hooks/useColumnResize";
import { AccountMenu, GroupMenu, LabelMenu, UngroupedMenu, useRowMenu } from "./EntityMenus";
import { Count, InlineNameField, RowIconButton, SidebarRow, sidebarRowClass } from "./SidebarRow";
import { SidebarFooter } from "./SidebarFooter";
import { MatchCount, SidebarSearch, useSearchMatches, type SearchMatches } from "./SidebarSearch";
import { AccountsSortable, GroupsDnd, SortableItem, type DragHandle } from "./GroupsDnd";

const MAIL_VIEWS: { kind: ViewKind; label: string; icon: LucideIcon }[] = [
  { kind: "inbox", label: "Inbox", icon: InboxIcon },
  { kind: "unread", label: "Unread", icon: MailIcon },
  { kind: "starred", label: "Starred", icon: StarIcon },
  { kind: "drafts", label: "Drafts", icon: FileTextIcon },
  { kind: "sent", label: "Sent", icon: SendIcon },
];

const MORE_VIEWS: { kind: ViewKind; label: string; icon: LucideIcon }[] = [
  { kind: "archive", label: "Archive", icon: ArchiveIcon },
  { kind: "all", label: "All mail", icon: MailsIcon },
  { kind: "attachments", label: "Attachments", icon: PaperclipIcon },
  { kind: "spam", label: "Spam", icon: OctagonAlertIcon },
  { kind: "trash", label: "Trash", icon: Trash2Icon },
];

const ACCOUNT_VIEWS: { kind: ViewKind; label: string; icon: LucideIcon }[] = [
  { kind: "inbox", label: "Inbox", icon: InboxIcon },
  { kind: "sent", label: "Sent", icon: SendIcon },
  { kind: "drafts", label: "Drafts", icon: FileTextIcon },
  { kind: "archive", label: "Archive", icon: ArchiveIcon },
  { kind: "spam", label: "Spam", icon: OctagonAlertIcon },
  { kind: "trash", label: "Trash", icon: Trash2Icon },
];

function useActiveKey(): string | null {
  return useUi((s) => (s.route.page === "mail" ? viewKey(s.route.view) : null));
}

function go(view: ViewRef) {
  navigate({ page: "mail", view, threadId: null });
}

export function Sidebar() {
  const width = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const resize = useColumnResize({ width, min: SIDEBAR_MIN, max: SIDEBAR_MAX, onChange: setWidth, defaultWidth: SIDEBAR_DEFAULT });

  return (
    <aside
      data-app-sidebar
      className="relative flex h-full shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground"
      style={{ width }}
    >
      <SidebarTop />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col pb-2">
          <MailSection />
          <GroupsSection />
          <LabelsSection />
        </div>
      </ScrollArea>
      <SidebarFooter />
      <div {...resize.handleProps} style={{ left: "100%" }} aria-label="Resize sidebar" />
    </aside>
  );
}

// ── Top: wordmark, New message, search ──────────────────────────────────────────────────────

/** While searching, a row with no matches fades back. */
const NO_MATCHES = "opacity-45 hover:opacity-100";

function SidebarTop() {
  const openCompose = useUi((s) => s.openCompose);
  const composing = useUi((s) => s.compose !== null && s.compose.draftId === null && s.compose.threadId === null);
  return (
    <div className="flex shrink-0 flex-col gap-1 px-[var(--sidebar-content-inset)] pb-1">
      <div
        data-drag-region
        className="app-drag flex h-[var(--header-height)] items-center gap-2"
        // On a Mac the window buttons sit here (the shell sets the inset; 0 elsewhere and in full screen).
        style={{ paddingInlineStart: "max(0.625rem, calc(var(--desktop-window-controls-inset, 0px) - var(--sidebar-content-inset)))" }}
      >
        <img src="./favicon.png" alt="" className="size-5 rounded-[5px]" draggable={false} />
        <span className="font-semibold text-sm tracking-tight text-sidebar-foreground">Fancy Mail</span>
      </div>
      <button type="button" className={sidebarRowClass} data-active={composing ? "true" : undefined} onClick={() => openCompose()}>
        <SquarePenIcon />
        <span className="min-w-0 flex-1 truncate">New message</span>
        <Kbd>C</Kbd>
      </button>
      <SidebarSearch />
    </div>
  );
}

// ── Section header with a hover "+" ─────────────────────────────────────────────────────────

function Section({
  id,
  title,
  onAdd,
  addLabel,
  children,
}: {
  id: string;
  title: ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  const collapsed = useUi((s) => !!s.collapsedSections[id]);
  const toggle = useUi((s) => s.toggleSection);
  return (
    <section className="group/section px-[var(--sidebar-content-inset)] pt-2">
      <div className="relative">
        <CollapsibleSectionHeader expanded={!collapsed} onClick={() => toggle(id)}>
          {title}
        </CollapsibleSectionHeader>
        {onAdd ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={addLabel}
                  onClick={onAdd}
                  className="absolute top-1.5 right-6 grid size-5 cursor-pointer place-items-center rounded-sm bg-sidebar text-sidebar-muted-foreground opacity-0 outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/section:opacity-100"
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">{addLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {collapsed ? null : <div className="flex flex-col gap-0.5 pt-0.5">{children}</div>}
    </section>
  );
}

// ── Mail ────────────────────────────────────────────────────────────────────────────────────

function MailSection() {
  const active = useActiveKey();
  const matches = useSearchMatches();
  const dir = useDirectory();
  const { data: bootstrap } = useBootstrap();
  const drafts = useDrafts();
  const scope = useScope();
  const moreCollapsed = useUi((s) => !!s.collapsedSections.more);
  const toggle = useUi((s) => s.toggleSection);

  // The views look where the groups section points; their counts are that place's.
  const accounts = scopeAccounts(scope, dir);
  const ids = new Set(accounts.map((a) => a.id));
  const inboxUnread = accounts.reduce((sum, a) => sum + a.unreadInboxCount, 0);
  const draftCount = (drafts.data ?? []).filter((d) => (d.sendState === "draft" || d.sendState === "failed") && ids.has(d.accountId)).length;
  const counts: Partial<Record<ViewKind, number>> = { inbox: inboxUnread, unread: inboxUnread, drafts: draftCount };
  const moreActive = MORE_VIEWS.some((v) => active === viewKey({ kind: v.kind, scope }));
  const where = scopeLabel(scope, bootstrap);
  const inboxMatches = scope.type === "all" ? matches.total : matches.accounts(accounts);

  const row = (v: { kind: ViewKind; label: string; icon: LucideIcon }) => {
    const view: ViewRef = { kind: v.kind, scope };
    const Icon = v.icon;
    const count = counts[v.kind] ?? 0;
    // Searching from Inbox looks through all the mail it looks at, so Inbox counts those matches.
    const trailing = matches.active ? (
      v.kind === "inbox" ? <MatchCount value={inboxMatches} /> : null
    ) : (
      <Count value={count} strong={v.kind === "inbox"} />
    );
    return (
      <SidebarRow
        key={v.kind}
        active={active === viewKey(view)}
        leading={<Icon />}
        label={v.label}
        emphasized={matches.active ? v.kind === "inbox" && inboxMatches > 0 : v.kind === "inbox" && count > 0}
        trailing={trailing}
        onActivate={() => go(view)}
      />
    );
  };

  return (
    <Section
      id="mail"
      title={
        where ? (
          <span className="flex min-w-0 items-center gap-1" title={`Mail in ${where}`}>
            Mail
            <span aria-hidden>·</span>
            <span className="max-w-36 truncate text-sidebar-foreground/80">{where}</span>
          </span>
        ) : (
          "Mail"
        )
      }
    >
      {MAIL_VIEWS.map(row)}
      <button
        type="button"
        aria-expanded={!moreCollapsed || moreActive}
        className={cn(sidebarRowClass, "text-sidebar-muted-foreground/70")}
        onClick={() => toggle("more")}
      >
        <ChevronRightIcon className={cn("size-4 transition-transform", (!moreCollapsed || moreActive) && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate">More</span>
      </button>
      {!moreCollapsed || moreActive ? MORE_VIEWS.map(row) : null}
    </Section>
  );
}

// ── Groups and accounts ─────────────────────────────────────────────────────────────────────

function GroupsSection() {
  const dir = useDirectory();
  const matches = useSearchMatches();
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);

  const byGroup = useMemo(() => {
    const map = new Map<string | null, Account[]>();
    for (const account of dir.accounts) {
      const key = account.groupId && dir.groupById.has(account.groupId) ? account.groupId : null;
      const list = map.get(key) ?? [];
      list.push(account);
      map.set(key, list);
    }
    return map;
  }, [dir]);

  const ungrouped = byGroup.get(null) ?? [];
  const creating = renaming?.kind === "group" && renaming.id === "new";

  return (
    <Section id="groups" title="Groups" addLabel="New group" onAdd={() => setRenaming({ kind: "group", id: "new" })}>
      {dir.accounts.length > 1 ? <AllAccountsRow /> : null}
      <GroupsDnd
        groups={dir.groups}
        accountsByGroup={byGroup}
        renderGroup={(group, accounts, handle, dropTarget) => (
          <GroupBlock key={group.id} group={group} accounts={accounts} handle={handle} dropTarget={dropTarget} matches={matches} />
        )}
        renderUngrouped={(handleFor, dropTarget) =>
          ungrouped.length > 0 ? (
            <UngroupedBlock accounts={ungrouped} handleFor={handleFor} dropTarget={dropTarget} matches={matches} />
          ) : null
        }
      />
      {creating ? (
        <InlineNameField
          initial=""
          placeholder="Group name"
          leading={<ColorDot color={null} />}
          onCommit={(name) => {
            setRenaming(null);
            void createGroup(name);
          }}
          onCancel={() => setRenaming(null)}
        />
      ) : null}
      {dir.accounts.length === 0 ? (
        <button
          type="button"
          className={cn(sidebarRowClass, "text-sidebar-muted-foreground")}
          onClick={() => useUi.getState().openDialog({ type: "add-account" })}
        >
          <PlusIcon />
          <span className="min-w-0 flex-1 truncate">Add account</span>
        </button>
      ) : null}
    </Section>
  );
}

/** Everything at once: the views look at every account. */
function AllAccountsRow() {
  const dir = useDirectory();
  const scope = useScope();
  const onMail = useUi((s) => s.route.page === "mail");
  const unread = dir.accounts.reduce((sum, a) => sum + a.unreadInboxCount, 0);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={600}
        render={
          <SidebarRow
            scoped={onMail && scope.type === "all"}
            className="ps-1"
            leading={
              <span className="grid size-5 place-items-center">
                <LayersIcon className="size-3.5" />
              </span>
            }
            label="All accounts"
            emphasized={unread > 0}
            trailing={<Count value={unread} />}
            onActivate={() => goScope({ type: "all" })}
          />
        }
      />
      <TooltipPopup side="right">{`${MULTI_CLICK} groups or accounts to see several together`}</TooltipPopup>
    </Tooltip>
  );
}

function GroupBlock({
  group,
  accounts,
  handle,
  dropTarget,
  matches,
}: {
  group: Group;
  accounts: Account[];
  handle: DragHandle;
  dropTarget: boolean;
  matches: SearchMatches;
}) {
  const scope = useScope();
  const onMail = useUi((s) => s.route.page === "mail");
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);
  const menu = useRowMenu();
  const item: ScopeItem = { type: "group", id: group.id };
  const isRenaming = renaming?.kind === "group" && renaming.id === group.id;
  const collapsed = group.collapsed;
  const found = matches.accounts(accounts);

  return (
    <div className="flex flex-col gap-0.5">
      {isRenaming ? (
        <InlineNameField
          initial={group.name}
          placeholder="Group name"
          leading={<ColorDot color={group.color} />}
          onCommit={(name) => {
            setRenaming(null);
            void updateGroup(group.id, { name });
          }}
          onCancel={() => setRenaming(null)}
        />
      ) : (
        <SidebarRow
          ref={handle.ref}
          {...handle.attributes}
          {...handle.listeners}
          style={handle.style}
          scoped={onMail && scopeHas(scope, item)}
          dropTarget={dropTarget}
          className={cn("ps-1", matches.active && found === 0 && NO_MATCHES)}
          leading={
            <>
              <RowIconButton
                label={collapsed ? "Show accounts" : "Hide accounts"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void updateGroup(group.id, { collapsed: !collapsed });
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <ChevronRightIcon className={cn("transition-transform", !collapsed && "rotate-90")} />
              </RowIconButton>
              <ColorDot color={group.color} />
            </>
          }
          label={group.name}
          emphasized={matches.active ? found > 0 : group.unreadInboxCount > 0}
          trailing={matches.active ? <MatchCount value={found} /> : <Count value={group.unreadInboxCount} />}
          actionsOpen={menu.open}
          actions={
            <RowIconButton
              label="Group actions"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                menu.openFrom(event.currentTarget);
              }}
            >
              <MoreHorizontalIcon />
            </RowIconButton>
          }
          onContextMenu={menu.openAtPointer}
          onDoubleClick={() => setRenaming({ kind: "group", id: group.id })}
          onClick={(event) => {
            event.preventDefault();
            pickScope(item, event);
          }}
          onActivate={() => pickScope(item, { ctrlKey: false, metaKey: false })}
        />
      )}
      <GroupMenu group={group} menu={menu} />
      {!collapsed ? <AccountList accounts={accounts} groupKey={group.id} matches={matches} /> : null}
    </div>
  );
}

function UngroupedBlock({
  accounts,
  dropTarget,
  matches,
}: {
  accounts: Account[];
  handleFor?: unknown;
  dropTarget: boolean;
  matches: SearchMatches;
}) {
  const collapsed = useUi((s) => !!s.collapsedSections.ungrouped);
  const toggle = useUi((s) => s.toggleSection);
  const scope = useScope();
  const onMail = useUi((s) => s.route.page === "mail");
  // Like a group: a click shows all its accounts' mail, Ctrl+click adds it, the arrow folds it.
  const item: ScopeItem = { type: "group", id: UNGROUPED_ID };
  const menu = useRowMenu();
  const unread = accounts.reduce((sum, a) => sum + a.unreadInboxCount, 0);
  const found = matches.accounts(accounts);
  return (
    <div className="flex flex-col gap-0.5">
      <SidebarRow
        className={cn("ps-1", matches.active && found === 0 && NO_MATCHES)}
        scoped={onMail && scopeHas(scope, item)}
        dropTarget={dropTarget}
        leading={
          <>
            <RowIconButton
              label={collapsed ? "Show accounts" : "Hide accounts"}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                toggle("ungrouped");
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <ChevronRightIcon className={cn("transition-transform", !collapsed && "rotate-90")} />
            </RowIconButton>
            <ColorDot color={null} />
          </>
        }
        label={<span className="text-sidebar-muted-foreground">Ungrouped</span>}
        emphasized={matches.active ? found > 0 : unread > 0}
        trailing={matches.active ? <MatchCount value={found} /> : <Count value={unread} />}
        actionsOpen={menu.open}
        onContextMenu={menu.openAtPointer}
        onClick={(event) => {
          event.preventDefault();
          pickScope(item, event);
        }}
        onActivate={() => pickScope(item, { ctrlKey: false, metaKey: false })}
      />
      <UngroupedMenu menu={menu} />
      {!collapsed ? <AccountList accounts={accounts} groupKey={null} matches={matches} /> : null}
    </div>
  );
}

function AccountList({ accounts, groupKey, matches }: { accounts: Account[]; groupKey: string | null; matches: SearchMatches }) {
  return (
    <div className="ms-[13px] flex min-w-0 flex-col gap-0.5 border-sidebar-border border-l ps-1.5">
      <AccountsSortable ids={accounts.map((a) => `account:${a.id}`)}>
        {accounts.map((account) => (
          <SortableItem key={account.id} id={`account:${account.id}`} data={{ type: "account", groupKey }}>
            {(handle) => <AccountBlock account={account} handle={handle} matches={matches} />}
          </SortableItem>
        ))}
      </AccountsSortable>
    </div>
  );
}

function AccountBlock({ account, handle, matches }: { account: Account; handle: DragHandle; matches: SearchMatches }) {
  const active = useActiveKey();
  const { data: bootstrap } = useBootstrap();
  const expanded = useUi((s) => !!s.expandedAccounts[account.id]);
  const toggleExpanded = useUi((s) => s.toggleAccountExpanded);
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);
  const menu = useRowMenu();
  const scope = useScope();
  const onMail = useUi((s) => s.route.page === "mail");
  const item: ScopeItem = { type: "account", id: account.id };
  const isRenaming = renaming?.kind === "account" && renaming.id === account.id;
  const found = matches.account(account.id);

  const folders = useMemo(
    () =>
      (bootstrap?.mailboxes ?? [])
        .filter((m) => m.accountId === account.id && m.role === null)
        .sort((a, b) => a.path.localeCompare(b.path)),
    [bootstrap?.mailboxes, account.id],
  );

  if (isRenaming) {
    return (
      <InlineNameField
        initial={account.displayName}
        placeholder={account.email}
        allowEmpty
        leading={<AccountAvatar account={account} />}
        onCommit={(displayName) => {
          setRenaming(null);
          void updateAccount(account.id, { displayName });
        }}
        onCancel={() => setRenaming(null)}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Tooltip>
        <TooltipTrigger
          delay={600}
          render={
            <SidebarRow
              ref={handle.ref}
              {...handle.attributes}
              {...handle.listeners}
              style={handle.style}
              scoped={onMail && scopeHas(scope, item)}
              className={cn("ps-1.5", matches.active && found === 0 && NO_MATCHES)}
              leading={<AccountAvatar account={account} />}
              label={account.displayName || account.email}
              emphasized={matches.active ? found > 0 : account.unreadInboxCount > 0}
              trailing={
                <>
                  <AccountStatusMark account={account} />
                  {matches.active ? <MatchCount value={found} /> : <Count value={account.unreadInboxCount} />}
                </>
              }
              actionsOpen={menu.open}
              actions={
                <>
                  <RowIconButton
                    label={expanded ? "Hide folders" : "Show folders"}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleExpanded(account.id);
                    }}
                  >
                    <ChevronRightIcon className={cn("transition-transform", expanded && "rotate-90")} />
                  </RowIconButton>
                  <RowIconButton
                    label="Account settings"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openAccountSettings(account.id);
                    }}
                  >
                    <Settings2Icon />
                  </RowIconButton>
                </>
              }
              onContextMenu={menu.openAtPointer}
              onDoubleClick={() => setRenaming({ kind: "account", id: account.id })}
              onClick={(event) => {
                event.preventDefault();
                pickScope(item, event);
              }}
              onActivate={() => pickScope(item, { ctrlKey: false, metaKey: false })}
            />
          }
        />
        <TooltipPopup side="right">{account.email}</TooltipPopup>
      </Tooltip>
      <AccountMenu account={account} menu={menu} />
      {expanded ? (
        <div className="ms-[15px] flex min-w-0 flex-col gap-0.5 border-sidebar-border border-l ps-1.5">
          {ACCOUNT_VIEWS.map((v) => {
            const sub: ViewRef = { kind: v.kind, scope: { type: "account", accountId: account.id } };
            const Icon = v.icon;
            return (
              <SidebarRow
                key={v.kind}
                className="h-7 text-[13px]"
                active={active === viewKey(sub)}
                leading={<Icon className="size-3.5" />}
                label={v.label}
                trailing={v.kind === "inbox" ? <Count value={account.unreadInboxCount} /> : null}
                onActivate={() => go(sub)}
              />
            );
          })}
          {folders.map((folder) => {
            const sub: ViewRef = { kind: "mailbox", accountId: account.id, mailboxId: folder.id };
            return (
              <SidebarRow
                key={folder.id}
                className="h-7 text-[13px]"
                active={active === viewKey(sub)}
                leading={<FolderIcon className="size-3.5" />}
                label={folder.name}
                title={folder.path}
                trailing={<Count value={folder.unreadCount} />}
                onActivate={() => go(sub)}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── Labels ──────────────────────────────────────────────────────────────────────────────────

function LabelsSection() {
  const dir = useDirectory();
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);
  const creating = renaming?.kind === "label" && renaming.id === "new";
  return (
    <Section id="labels" title="Labels" addLabel="New label" onAdd={() => setRenaming({ kind: "label", id: "new" })}>
      {dir.labels.map((label) => (
        <LabelRow key={label.id} label={label} />
      ))}
      {creating ? (
        <InlineNameField
          initial=""
          placeholder="Label name"
          leading={<TagIcon className="size-4 text-[var(--sidebar-icon-color)]" />}
          onCommit={(name) => {
            setRenaming(null);
            void createLabel(name);
          }}
          onCancel={() => setRenaming(null)}
        />
      ) : null}
      {dir.labels.length === 0 && !creating ? (
        <p className="px-[var(--sidebar-row-content-inset)] py-1 text-sidebar-muted-foreground/70 text-xs">
          Labels you or your agents create show up here.
        </p>
      ) : null}
    </Section>
  );
}

function LabelRow({ label }: { label: Label }) {
  const active = useActiveKey();
  const matches = useSearchMatches();
  const found = matches.label(label.id);
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);
  const menu = useRowMenu();
  const dir = useDirectory();
  const scope = useScope();
  const view: ViewRef = { kind: "label", labelId: label.id, scope };
  // Counted where the views look; a label with nothing there fades back.
  let unread = label.unreadThreadCount;
  let threads = label.threadCount;
  if (scope.type !== "all") {
    unread = 0;
    threads = 0;
    for (const a of scopeAccounts(scope, dir)) {
      unread += label.byAccount[a.id]?.unread ?? 0;
      threads += label.byAccount[a.id]?.threads ?? 0;
    }
  }
  const empty = scope.type !== "all" && threads === 0 && active !== viewKey(view);
  if (renaming?.kind === "label" && renaming.id === label.id) {
    return (
      <InlineNameField
        initial={label.name}
        placeholder="Label name"
        leading={<ColorDot color={label.color} className="mx-1" />}
        onCommit={(name) => {
          setRenaming(null);
          void updateLabel(label.id, { name });
        }}
        onCancel={() => setRenaming(null)}
      />
    );
  }
  return (
    <>
      <SidebarRow
        active={active === viewKey(view)}
        className={cn((matches.active ? found === 0 : empty) && NO_MATCHES)}
        leading={<ColorDot color={label.color} className="mx-1" />}
        label={label.name}
        emphasized={matches.active ? found > 0 : unread > 0}
        trailing={matches.active ? <MatchCount value={found} /> : <Count value={unread} />}
        actionsOpen={menu.open}
        actions={
          <RowIconButton
            label="Label actions"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              menu.openFrom(event.currentTarget);
            }}
          >
            <MoreHorizontalIcon />
          </RowIconButton>
        }
        onContextMenu={menu.openAtPointer}
        onDoubleClick={() => setRenaming({ kind: "label", id: label.id })}
        onActivate={() => go(view)}
      />
      <LabelMenu label={label} menu={menu} />
    </>
  );
}
