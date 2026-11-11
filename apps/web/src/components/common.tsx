/** Small pieces shared by the sidebar, the list, the reader and settings. */
import {
  AGENT_ACCESS_INFO,
  AGENT_ACCESS_LEVELS,
  COLOR_PALETTE,
  type Account,
  type AgentAccess,
  type Label,
} from "@fancy-mail/contracts";
import { CheckIcon, CloudOffIcon, KeyRoundIcon, PanelLeftOpenIcon, PauseIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { Badge } from "~/components/ui/badge";
import { Button, type ButtonSize, type ButtonVariant } from "~/components/ui/button";
import { MenuItem, MenuRadioGroup, MenuRadioItem, MenuRadioItemIndicator, MenuSub, MenuSubPopup, MenuSubTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { colorForAddress, initialOf } from "~/lib/addresses";
import { cn } from "~/lib/utils";
import { useUi } from "~/state/ui";

// ── Avatars and dots ────────────────────────────────────────────────────────────────────────

export function AccountAvatar({ account, size = 20, className }: { account: Pick<Account, "displayName" | "email" | "color">; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold text-white leading-none", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        background: account.color,
      }}
    >
      {initialOf(account.displayName || account.email)}
    </span>
  );
}

export function PersonAvatar({ name, address, size = 32 }: { name: string; address: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0 place-items-center rounded-full font-semibold text-white leading-none"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: colorForAddress(address) }}
    >
      {initialOf(name || address)}
    </span>
  );
}

export function ColorDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", !color && "bg-muted-foreground/50", className)}
      style={color ? { background: color } : undefined}
    />
  );
}

/** A label as a quiet tinted chip (T3's Badge "label" variant). */
export function LabelChip({ label, onRemove, className }: { label: Pick<Label, "name" | "color">; onRemove?: () => void; className?: string }) {
  return (
    <Badge
      variant="label"
      size="default"
      className={cn("max-w-36 gap-1", onRemove && "pe-0.5", className)}
      style={{ "--label": label.color ?? "var(--color-neutral-400)" } as CSSProperties}
    >
      <span className="truncate">{label.name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove label ${label.name}`}
          className="grid size-3.5 shrink-0 cursor-pointer place-items-center rounded-sm opacity-70 hover:bg-white/10 hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <XIcon className="size-2.5" />
        </button>
      ) : null}
    </Badge>
  );
}

// ── Account status ──────────────────────────────────────────────────────────────────────────

export function statusText(account: Account): string {
  const { state, message, progress } = account.status;
  switch (state) {
    case "syncing":
      return progress && progress.total > 0 ? `Syncing ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}` : "Syncing";
    case "connecting":
      return "Connecting";
    case "offline":
      return message ?? "Offline. Retrying by itself.";
    case "auth-required":
      return message ?? "The server refused the sign-in. Reconnect to keep syncing.";
    case "error":
      return message ?? "Sync stopped because of an error.";
    case "paused":
      return account.provider === "demo" ? "Demo account" : "Paused";
    case "ready":
      // Older mail still coming down in the background.
      return progress && progress.total > 0
        ? `Up to date · getting older mail ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
        : "Up to date";
    default:
      return "Waiting to sync";
  }
}

/** Spinner while syncing, cloud-off offline, amber key for "Reconnect", nothing when fine. */
export function AccountStatusMark({ account, className }: { account: Account; className?: string }) {
  const { state } = account.status;
  let mark: ReactNode = null;
  if (state === "syncing" || state === "connecting") mark = <Spinner size="xs" tone="muted" />;
  else if (state === "offline") mark = <CloudOffIcon className="size-3.5 text-muted-foreground/70" />;
  else if (state === "auth-required") mark = <KeyRoundIcon className="size-3.5 text-warning" />;
  else if (state === "error") mark = <TriangleAlertIcon className="size-3.5 text-warning" />;
  else if (state === "paused" && account.provider !== "demo") mark = <PauseIcon className="size-3 text-muted-foreground/70" />;
  if (!mark) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("inline-grid size-4 shrink-0 place-items-center", className)} aria-label={statusText(account)} />}>
        {mark}
      </TooltipTrigger>
      <TooltipPopup side="right">{statusText(account)}</TooltipPopup>
    </Tooltip>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────────────────────────────

/** An icon button with a tooltip (and the shortcut in it). */
export function IconButton({
  label,
  shortcut,
  onClick,
  children,
  variant = "ghost-muted",
  size = "icon-sm",
  disabled,
  side = "bottom",
  pressed,
  className,
}: {
  label: string;
  shortcut?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  side?: "top" | "bottom" | "left" | "right";
  pressed?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={variant}
            size={size}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={className}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side={side}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut ? <span className="text-muted-foreground">{shortcut}</span> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

export function WithTooltip({ label, children, side = "top" }: { label: ReactNode; children: ReactElement; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side={side}>{label}</TooltipPopup>
    </Tooltip>
  );
}

// ── Menu pieces ─────────────────────────────────────────────────────────────────────────────

export function ColorSubmenu({ value, onChange, allowNone = false }: { value: string | null; onChange(color: string | null): void; allowNone?: boolean }) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <ColorDot color={value} className="mx-1" />
        Color
      </MenuSubTrigger>
      <MenuSubPopup>
        <div className="grid grid-cols-6 gap-1 p-1">
          {COLOR_PALETTE.map((color) => (
            <MenuItem
              key={color}
              aria-label={color}
              className="grid size-7 min-h-0 place-items-center p-0 sm:min-h-0"
              onClick={() => onChange(color)}
            >
              <span className="grid size-4 place-items-center rounded-full" style={{ background: color }}>
                {value?.toLowerCase() === color ? <CheckIcon className="size-3 text-white" strokeWidth={3} /> : null}
              </span>
            </MenuItem>
          ))}
        </div>
        {allowNone ? (
          <MenuItem onClick={() => onChange(null)}>
            <ColorDot color={null} className="mx-1" />
            No color
          </MenuItem>
        ) : null}
      </MenuSubPopup>
    </MenuSub>
  );
}

export function AgentAccessSubmenu({ value, onChange }: { value: AgentAccess; onChange(level: AgentAccess): void }) {
  return (
    <MenuSub>
      <MenuSubTrigger>Agent access</MenuSubTrigger>
      <MenuSubPopup className="w-72">
        <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as AgentAccess)}>
          {AGENT_ACCESS_LEVELS.map((level) => (
            <MenuRadioItem key={level} value={level} className="items-start py-1.5">
              <span className="flex items-start gap-2">
                <span className="flex h-5 w-3.5 shrink-0 items-center">
                  <MenuRadioItemIndicator />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">{AGENT_ACCESS_INFO[level].label}</span>
                  <span className="block text-muted-foreground text-xs">{AGENT_ACCESS_INFO[level].description}</span>
                </span>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** A virtual anchor at the pointer, for context menus. */
export function pointAnchor(x: number, y: number) {
  return {
    getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
  };
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("font-medium text-sm text-foreground", className)}>{children}</h2>;
}

/** Brings the sidebar back after Ctrl+B hid it (nothing while it is shown). */
export function ShowSidebarButton() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  if (!collapsed) return null;
  return (
    <IconButton label="Show sidebar" shortcut="Ctrl+B" onClick={toggle}>
      <PanelLeftOpenIcon />
    </IconButton>
  );
}
