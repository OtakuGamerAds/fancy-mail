/**
 * The sidebar, after T3 Code's (components/Sidebar.tsx and ui/sidebar.tsx, MIT License — see
 * THIRD_PARTY_LICENSE_T3CODE.txt): New message and the search pill on top; Mail, Groups and
 * Labels sections that collapse; a pinned footer with Activity, the agent line and Settings.
 */
import type { Account, Group, Label, ViewKind } from "@fancy-mail/contracts";
import {
  ArchiveIcon,
  ChevronRightIcon,
  FileTextIcon,
  InboxIcon,
  MailIcon,
  MailsIcon,
  MoreHorizontalIcon,
  OctagonAlertIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
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
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useUi } from "~/state/ui";
import { useColumnResize } from "~/hooks/useColumnResize";
import { AccountMenu, GroupMenu, LabelMenu, useRowMenu } from "./EntityMenus";
import { Count, InlineNameField, RowIconButton, SidebarRow, sidebarRowClass } from "./SidebarRow";
import { SidebarFooter } from "./SidebarFooter";
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

function SidebarTop() {
  const openCompose = useUi((s) => s.openCompose);
  const openPalette = useUi((s) => s.openPalette);
  return (
    <div className="flex shrink-0 flex-col gap-1 px-[var(--sidebar-content-inset)] pb-1">
      <div data-drag-region className="app-drag flex h-[var(--header-height)] items-center gap-2 ps-2.5">
        <img src="./favicon.png" alt="" className="size-5 rounded-[5px]" draggable={false} />
        <span className="font-semibold text-sm tracking-tight text-sidebar-foreground">Fancy Mail</span>
      </div>
      <button type="button" className={sidebarRowClass} onClick={() => openCompose()}>
        <SquarePenIcon />
        <span className="min-w-0 flex-1 truncate">New message</span>
        <Kbd>C</Kbd>
      </button>
      <button
        type="button"
        onClick={openPalette}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--control-radius)] bg-sidebar-control-surface px-[var(--sidebar-row-content-inset)] text-left text-sm text-sidebar-muted-foreground ring-1 ring-sidebar-border outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SearchIcon className="size-4 shrink-0 text-[var(--sidebar-icon-color)]" />
        <span className="min-w-0 flex-1 truncate">Search mail</span>
        <Kbd>Ctrl K</Kbd>
      </button>
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
  title: string;
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
  const dir = useDirectory();
  const drafts = useDrafts();
  const moreCollapsed = useUi((s) => !!s.collapsedSections.more);
  const toggle = useUi((s) => s.toggleSection);

  const inboxUnread = dir.accounts.reduce((sum, a) => sum + a.unreadInboxCount, 0);
  const draftCount = (drafts.data ?? []).filter((d) => d.sendState === "draft" || d.sendState === "failed").length;
  const counts: Partial<Record<ViewKind, number>> = { inbox: inboxUnread, unread: inboxUnread, drafts: draftCount };
  const moreActive = MORE_VIEWS.some((v) => active === viewKey({ kind: v.kind, scope: { type: "all" } }));

  const row = (v: { kind: ViewKind; label: string; icon: LucideIcon }) => {
    const view: ViewRef = { kind: v.kind, scope: { type: "all" } };
    const Icon = v.icon;
    const count = counts[v.kind] ?? 0;
    return (
      <SidebarRow
        key={v.kind}
        active={active === viewKey(view)}
        leading={<Icon />}
        label={v.label}
        emphasized={v.kind === "inbox" && count > 0}
        trailing={<Count value={count} strong={v.kind === "inbox"} />}
        onActivate={() => go(view)}
      />
    );
  };

  return (
    <Section id="mail" title="Mail">
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
      <GroupsDnd
        groups={dir.groups}
        accountsByGroup={byGroup}
        renderGroup={(group, accounts, handle, dropTarget) => (
          <GroupBlock key={group.id} group={group} accounts={accounts} handle={handle} dropTarget={dropTarget} />
        )}
        renderUngrouped={(handleFor, dropTarget) =>
          ungrouped.length > 0 ? (
            <UngroupedBlock accounts={ungrouped} handleFor={handleFor} dropTarget={dropTarget} />
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

function GroupBlock({ group, accounts, handle, dropTarget }: { group: Group; accounts: Account[]; handle: DragHandle; dropTarget: boolean }) {
  const active = useActiveKey();
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);
  const menu = useRowMenu();
  const view: ViewRef = { kind: "inbox", scope: { type: "group", groupId: group.id } };
  const isRenaming = renaming?.kind === "group" && renaming.id === group.id;
  const collapsed = group.collapsed;

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
          active={active === viewKey(view)}
          dropTarget={dropTarget}
          className="ps-1"
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
          emphasized={group.unreadInboxCount > 0}
          trailing={<Count value={group.unreadInboxCount} />}
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
          onActivate={() => go(view)}
        />
      )}
      <GroupMenu group={group} menu={menu} />
      {!collapsed ? <AccountList accounts={accounts} groupKey={group.id} /> : null}
    </div>
  );
}

function UngroupedBlock({ accounts, dropTarget }: { accounts: Account[]; handleFor?: unknown; dropTarget: boolean }) {
  const collapsed = useUi((s) => !!s.collapsedSections.ungrouped);
  const toggle = useUi((s) => s.toggleSection);
  const unread = accounts.reduce((sum, a) => sum + a.unreadInboxCount, 0);
  return (
    <div className="flex flex-col gap-0.5">
      <SidebarRow
        className="ps-1"
        dropTarget={dropTarget}
        active={false}
        leading={
          <>
            <span className="grid size-5 place-items-center">
              <ChevronRightIcon className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")} />
            </span>
            <ColorDot color={null} />
          </>
        }
        label={<span className="text-sidebar-muted-foreground">Ungrouped</span>}
        trailing={<Count value={unread} />}
        onActivate={() => toggle("ungrouped")}
      />
      {!collapsed ? <AccountList accounts={accounts} groupKey={null} /> : null}
    </div>
  );
}

function AccountList({ accounts, groupKey }: { accounts: Account[]; groupKey: string | null }) {
  return (
    <div className="ms-[13px] flex min-w-0 flex-col gap-0.5 border-sidebar-border border-l ps-1.5">
      <AccountsSortable ids={accounts.map((a) => `account:${a.id}`)}>
        {accounts.map((account) => (
          <SortableItem key={account.id} id={`account:${account.id}`} data={{ type: "account", groupKey }}>
            {(handle) => <AccountBlock account={account} handle={handle} />}
          </SortableItem>
        ))}
      </AccountsSortable>
    </div>
  );
}

function AccountBlock({ account, handle }: { account: Account; handle: DragHandle }) {
  const active = useActiveKey();
  const { data: bootstrap } = useBootstrap();
  const expanded = useUi((s) => !!s.expandedAccounts[account.id]);
  const toggleExpanded = useUi((s) => s.toggleAccountExpanded);
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);
  const menu = useRowMenu();
  const view: ViewRef = { kind: "inbox", scope: { type: "account", accountId: account.id } };
  const isRenaming = renaming?.kind === "account" && renaming.id === account.id;

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
        placeholder="Account name"
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
              active={active === viewKey(view)}
              className="ps-1.5"
              leading={<AccountAvatar account={account} />}
              label={account.displayName || account.email}
              emphasized={account.unreadInboxCount > 0}
              trailing={
                <>
                  <AccountStatusMark account={account} />
                  <Count value={account.unreadInboxCount} />
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
                    label="Account actions"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      menu.openFrom(event.currentTarget);
                    }}
                  >
                    <MoreHorizontalIcon />
                  </RowIconButton>
                </>
              }
              onContextMenu={menu.openAtPointer}
              onActivate={() => go(view)}
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
  const renaming = useUi((s) => s.renaming);
  const setRenaming = useUi((s) => s.setRenaming);
  const menu = useRowMenu();
  const view: ViewRef = { kind: "label", labelId: label.id, scope: { type: "all" } };
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
        leading={<ColorDot color={label.color} className="mx-1" />}
        label={label.name}
        emphasized={label.unreadThreadCount > 0}
        trailing={<Count value={label.unreadThreadCount} />}
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
