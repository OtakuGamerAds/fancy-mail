/** Settings › Accounts: every account by group, with its status, agent access and actions. */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useEffect, useRef, useState } from "react";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AGENT_ACCESS_INFO, AGENT_ACCESS_LEVELS, type Account, type AgentAccess } from "@fancy-mail/contracts";
import { GripVerticalIcon, KeyRoundIcon, PauseIcon, PlayIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import { AccountAvatar, ColorDot, IconButton, statusText } from "~/components/common";
import { startReconnect } from "~/components/dialogs/reconnect";
import { FieldSelect } from "~/components/selects";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { formatRelative } from "~/lib/format";
import { cn } from "~/lib/utils";
import { reorderAccounts, syncNow, updateAccount } from "~/state/actions";
import { useDirectory } from "~/state/queries";
import { navigate } from "~/state/router";
import { useUi } from "~/state/ui";
import { SettingsSection } from "./layout";

const PROVIDER_NAMES: Record<Account["provider"], string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  imap: "IMAP",
  demo: "Demo",
};

export const ACCESS_CHOICES = AGENT_ACCESS_LEVELS.map((level) => ({
  value: level,
  label: AGENT_ACCESS_INFO[level].label,
  description: AGENT_ACCESS_INFO[level].description,
}));

/** Opens Settings › Accounts on one account. */
export function openAccountSettings(accountId: string): void {
  useUi.getState().setSettingsAccountId(accountId);
  navigate({ page: "settings", section: "accounts" });
}

export function AccountsSettings() {
  const dir = useDirectory();
  const openDialog = useUi((s) => s.openDialog);
  const buckets: { key: string | null; title: string; color: string | null; accounts: Account[] }[] = [
    ...dir.groups.map((g) => ({ key: g.id, title: g.name, color: g.color, accounts: dir.accounts.filter((a) => a.groupId === g.id) })),
  ];
  const ungrouped = dir.accounts.filter((a) => !a.groupId || !dir.groupById.has(a.groupId));
  if (ungrouped.length > 0) buckets.push({ key: null, title: "Ungrouped", color: null, accounts: ungrouped });

  return (
    <>
      <SettingsSection
        title="Accounts"
        description="Drag to reorder. Removing an account only forgets it here; nothing on the mail server is deleted."
        action={
          <Button size="sm" onClick={() => openDialog({ type: "add-account" })}>
            <PlusIcon />
            Add account
          </Button>
        }
        plain
      >
        {dir.accounts.length === 0 ? (
          <div className="rounded-xl border border-border/60 border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
            No accounts yet.
          </div>
        ) : (
          <div className="space-y-5">
            {buckets
              .filter((b) => b.accounts.length > 0)
              .map((bucket) => (
                <div key={bucket.key ?? "none"} className="space-y-1.5">
                  <div className="flex items-center gap-2 px-3 font-medium text-muted-foreground text-xs sm:px-4">
                    <ColorDot color={bucket.color} />
                    {bucket.title}
                  </div>
                  <SortableAccounts accounts={bucket.accounts} groupId={bucket.key} />
                </div>
              ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}

function SortableAccounts({ accounts, groupId }: { accounts: Account[]; groupId: string | null }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = accounts.map((a) => a.id);
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    void reorderAccounts(arrayMove(ids, from, to), groupId);
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-border/50 [&>*+*]:border-t">
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function AccountRow({ account }: { account: Account }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: account.id });
  const ui = useUi.getState();
  const state = account.status.state;
  const paused = state === "paused";
  const isDemo = account.provider === "demo";
  const needsSignIn = state === "auth-required";
  const busy = state === "syncing" || state === "connecting";
  const wanted = useUi((s) => s.settingsAccountId === account.id);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [marked, setMarked] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setMarked(true);
    useUi.getState().setSettingsAccountId(null);
    const timer = setTimeout(() => setMarked(false), 1600);
    return () => clearTimeout(timer);
  }, [wanted]);
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        rowRef.current = el;
      }}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 10 : undefined, position: "relative" }}
      className={cn(
        "flex flex-col gap-2 bg-card/40 px-3 py-3 transition-[background-color,box-shadow] duration-500 sm:px-4",
        isDragging && "rounded-xl shadow-lg",
        marked && "bg-primary/10 shadow-[inset_0_0_0_1px_var(--ring)]",
      )}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move ${account.email}`}
          className="-ms-1.5 grid size-6 shrink-0 cursor-grab place-items-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <AccountAvatar account={account} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-sm">{account.displayName || account.email}</span>
            <span className="shrink-0 text-muted-foreground text-xs">{PROVIDER_NAMES[account.provider]}</span>
          </div>
          <div className="truncate text-muted-foreground text-xs" data-selectable>
            {account.email}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {!isDemo ? (
            <IconButton label="Sync now" disabled={paused} onClick={() => syncNow(account.id)}>
              <RefreshCwIcon />
            </IconButton>
          ) : null}
          {!isDemo ? (
            <IconButton label={paused ? "Resume syncing" : "Pause syncing"} onClick={() => void updateAccount(account.id, { paused: !paused })}>
              {paused ? <PlayIcon /> : <PauseIcon />}
            </IconButton>
          ) : null}
          <IconButton label="Remove account" variant="ghost-destructive" onClick={() => ui.openDialog({ type: "remove-account", accountId: account.id })}>
            <Trash2Icon />
          </IconButton>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 ps-[3.25rem]">
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 text-xs",
            needsSignIn || state === "error" ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {busy ? <Spinner size="xs" tone="muted" /> : <StatusDot account={account} />}
          <span className="truncate">{statusText(account)}</span>
          {account.status.lastSyncAt && state !== "syncing" ? (
            <span className="shrink-0 text-muted-foreground/70">· {formatRelative(account.status.lastSyncAt)}</span>
          ) : null}
        </span>
        {needsSignIn ? (
          <Button size="xs" variant="warning-outline" onClick={() => startReconnect(account)}>
            <KeyRoundIcon />
            {account.authKind === "password" ? "Reconnect" : "Sign in again"}
          </Button>
        ) : null}
        <label className="flex items-center gap-2 text-muted-foreground text-xs">
          Agents
          <FieldSelect<AgentAccess>
            items={ACCESS_CHOICES}
            value={account.agentAccess}
            onChange={(agentAccess) => void updateAccount(account.id, { agentAccess })}
            ariaLabel={`Agent access for ${account.email}`}
            size="xs"
            className="w-auto min-w-28"
          />
        </label>
      </div>
      <div className="grid gap-x-4 gap-y-2 ps-[3.25rem] sm:grid-cols-2">
        <NameField
          label="Name in Fancy Mail"
          hint="Only you see it. Leave it empty to show the address."
          value={account.displayName}
          placeholder={account.email}
          onCommit={(displayName) => void updateAccount(account.id, { displayName })}
        />
        {!isDemo ? (
          <NameField
            label="Sender name"
            hint="What people see when you email them."
            value={account.senderName}
            placeholder="Just the address"
            onCommit={(senderName) => void updateAccount(account.id, { senderName })}
          />
        ) : null}
      </div>
    </div>
  );
}

/** A name saved on Enter or when leaving the field; Escape puts the old one back. */
function NameField({
  label,
  hint,
  value,
  placeholder,
  required,
  onCommit,
}: {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  required?: boolean;
  onCommit(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next === value) return;
    if (required && !next) return setDraft(value);
    onCommit(next);
  };
  return (
    <label className="block min-w-0 space-y-1">
      <span className="block font-medium text-muted-foreground text-xs">{label}</span>
      <Input
        size="sm"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(value);
            requestAnimationFrame(() => (event.target as HTMLInputElement).blur());
          }
        }}
      />
      <span className="block text-muted-foreground/80 text-xs">{hint}</span>
    </label>
  );
}

function StatusDot({ account }: { account: Account }) {
  const state = account.status.state;
  const color =
    state === "ready"
      ? "bg-success"
      : state === "auth-required" || state === "error"
        ? "bg-warning"
        : state === "offline"
          ? "bg-muted-foreground/50"
          : "bg-muted-foreground/30";
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", color)} />;
}
