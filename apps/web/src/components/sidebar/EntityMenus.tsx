/**
 * The context menus of a group, an account and a label. One menu per row, opened either by a
 * right click (anchored at the pointer) or by the row's "…" button (anchored to it), so there
 * is never a second menu beside the first.
 */
import type { Account, Group, Label } from "@fancy-mail/contracts";
import {
  CogIcon,
  FolderInputIcon,
  FolderPlusIcon,
  KeyRoundIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";

import { AgentAccessSubmenu, ColorDot, ColorSubmenu, pointAnchor } from "~/components/common";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { syncNow, updateAccount, updateGroup, updateLabel } from "~/state/actions";
import { useDirectory } from "~/state/queries";
import { navigate } from "~/state/router";
import { useUi } from "~/state/ui";
import { startReconnect } from "~/components/dialogs/reconnect";

type Anchor = Element | { getBoundingClientRect(): DOMRect } | null;

export interface RowMenuState {
  open: boolean;
  anchor: Anchor;
  openAtPointer(event: ReactMouseEvent): void;
  openFrom(element: Element): void;
  setOpen(open: boolean): void;
}

export function useRowMenu(): RowMenuState {
  const [state, setState] = useState<{ open: boolean; anchor: Anchor }>({ open: false, anchor: null });
  const openAtPointer = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ open: true, anchor: pointAnchor(event.clientX, event.clientY) });
  }, []);
  const openFrom = useCallback((element: Element) => setState({ open: true, anchor: element }), []);
  const setOpen = useCallback((open: boolean) => setState((s) => ({ ...s, open })), []);
  return { ...state, openAtPointer, openFrom, setOpen };
}

function RowMenuShell({ menu, children, width = "w-56" }: { menu: RowMenuState; children: React.ReactNode; width?: string }) {
  return (
    <Menu open={menu.open} onOpenChange={menu.setOpen} modal={false}>
      <MenuPopup anchor={menu.anchor ?? undefined} align="start" side="bottom" className={width}>
        {children}
      </MenuPopup>
    </Menu>
  );
}

export function GroupMenu({ group, menu }: { group: Group; menu: RowMenuState }) {
  const ui = useUi.getState();
  return (
    <RowMenuShell menu={menu}>
      <MenuItem onClick={() => ui.setRenaming({ kind: "group", id: group.id })}>
        <PencilIcon />
        Rename
      </MenuItem>
      <ColorSubmenu value={group.color} onChange={(color) => color && void updateGroup(group.id, { color })} />
      <MenuItem onClick={() => ui.setRenaming({ kind: "group", id: "new" })}>
        <FolderPlusIcon />
        New group
      </MenuItem>
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={() => ui.openDialog({ type: "delete-group", groupId: group.id })}>
        <Trash2Icon />
        Delete group…
      </MenuItem>
    </RowMenuShell>
  );
}

export function AccountMenu({ account, menu }: { account: Account; menu: RowMenuState }) {
  const ui = useUi.getState();
  const dir = useDirectory();
  const paused = account.status.state === "paused";
  const isDemo = account.provider === "demo";
  return (
    <RowMenuShell menu={menu}>
      <MenuItem onClick={() => ui.setRenaming({ kind: "account", id: account.id })}>
        <PencilIcon />
        <span className="flex-1">Rename</span>
        <span className="text-muted-foreground text-xs">only here</span>
      </MenuItem>
      <ColorSubmenu value={account.color} onChange={(color) => color && void updateAccount(account.id, { color })} />
      <MenuSub>
        <MenuSubTrigger>
          <FolderInputIcon />
          Move to group
        </MenuSubTrigger>
        <MenuSubPopup className="w-52">
          <MenuRadioGroup
            value={account.groupId ?? "__none"}
            onValueChange={(value) => void updateAccount(account.id, { groupId: value === "__none" ? null : (value as string) })}
          >
            {dir.groups.map((g) => (
              <MenuRadioItem key={g.id} value={g.id}>
                <span className="flex items-center gap-2">
                  <ColorDot color={g.color} />
                  <span className="min-w-0 flex-1 truncate">{g.name}</span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
            <MenuRadioItem value="__none">
              <span className="flex items-center gap-2">
                <ColorDot color={null} />
                <span className="min-w-0 flex-1 truncate">Ungrouped</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuSubPopup>
      </MenuSub>
      <AgentAccessSubmenu value={account.agentAccess} onChange={(agentAccess) => void updateAccount(account.id, { agentAccess })} />
      <MenuSeparator />
      <MenuItem disabled={isDemo} onClick={() => syncNow(account.id)}>
        <RefreshCwIcon />
        Sync now
      </MenuItem>
      {!isDemo ? (
        <MenuItem onClick={() => void updateAccount(account.id, { paused: !paused })}>
          {paused ? <PlayIcon /> : <PauseIcon />}
          {paused ? "Resume syncing" : "Pause syncing"}
        </MenuItem>
      ) : null}
      {!isDemo ? (
        <MenuItem onClick={() => startReconnect(account)}>
          <KeyRoundIcon />
          Reconnect…
        </MenuItem>
      ) : null}
      <MenuItem onClick={() => navigate({ page: "settings", section: "accounts" })}>
        <CogIcon />
        Sender name & settings
      </MenuItem>
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={() => ui.openDialog({ type: "remove-account", accountId: account.id })}>
        <Trash2Icon />
        Remove account…
      </MenuItem>
    </RowMenuShell>
  );
}

export function LabelMenu({ label, menu }: { label: Label; menu: RowMenuState }) {
  const ui = useUi.getState();
  return (
    <RowMenuShell menu={menu} width="w-48">
      <MenuItem onClick={() => ui.setRenaming({ kind: "label", id: label.id })}>
        <PencilIcon />
        Rename
      </MenuItem>
      <ColorSubmenu value={label.color} allowNone onChange={(color) => void updateLabel(label.id, { color })} />
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={() => ui.openDialog({ type: "delete-label", labelId: label.id })}>
        <Trash2Icon />
        Delete label…
      </MenuItem>
    </RowMenuShell>
  );
}
