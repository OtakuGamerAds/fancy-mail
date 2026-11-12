/**
 * The sidebar row, after T3 Code's SidebarMenuButton (components/ui/sidebar.tsx, MIT License —
 * see THIRD_PARTY_LICENSE_T3CODE.txt): 32 px, control radius, muted until hovered or selected.
 * Trailing content (a count) gives way to hover actions on hover, so nothing jumps.
 */
import { forwardRef, useEffect, useRef, type ReactNode } from "react";

import { cn } from "~/lib/utils";

export const sidebarRowClass =
  "group/row relative flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-[var(--control-radius)] transition-[background-color,color,opacity] duration-150 px-[var(--sidebar-row-content-inset)] text-left text-sm font-medium text-sidebar-muted-foreground/80 outline-hidden ring-ring hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active data-[active=true]:bg-sidebar-row-selected data-[active=true]:text-sidebar-foreground data-[drop-target=true]:bg-primary/12 data-[drop-target=true]:ring-1 data-[drop-target=true]:ring-primary/50 [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-[var(--sidebar-icon-color)] hover:[&>svg:not([class*='text-'])]:text-sidebar-foreground data-[active=true]:[&>svg:not([class*='text-'])]:text-sidebar-foreground";

export interface SidebarRowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  active?: boolean;
  /** A group or account the mail views look at (tinted, unlike the open view's gray). */
  scoped?: boolean;
  dropTarget?: boolean;
  leading?: ReactNode;
  label: ReactNode;
  /** Shown at rest: a count, a status mark. */
  trailing?: ReactNode;
  /** Shown on hover (and while a menu from it is open), in place of `trailing`. */
  actions?: ReactNode;
  /** Keep the actions visible (its menu is open). */
  actionsOpen?: boolean;
  /** Bold label: something unread inside. */
  emphasized?: boolean;
  onActivate?: () => void;
}

export const SidebarRow = forwardRef<HTMLDivElement, SidebarRowProps>(function SidebarRow(
  { active, scoped, dropTarget, leading, label, trailing, actions, actionsOpen, emphasized, onActivate, className, onClick, onKeyDown, ...props },
  ref,
) {
  // A wrapper's handlers (a tooltip trigger, a drag handle) run first, then the row's own:
  // spreading them over the row's would silently take its click away.
  return (
    <div
      ref={ref}
      role="link"
      tabIndex={0}
      data-active={active ? "true" : undefined}
      data-scoped={scoped ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        sidebarRowClass,
        "data-[scoped=true]:bg-primary/14 data-[scoped=true]:text-sidebar-foreground data-[scoped=true]:hover:bg-primary/18 data-[scoped=true]:[&>svg:not([class*='text-'])]:text-sidebar-foreground",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        onActivate?.();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate?.();
        }
      }}
      {...props}
    >
      {leading}
      <span className={cn("min-w-0 flex-1 truncate", emphasized && "text-sidebar-foreground")}>{label}</span>
      {trailing || actions ? (
        <span className="relative flex h-full shrink-0 items-center">
          {trailing ? (
            <span
              className={cn(
                "flex items-center gap-1.5",
                actions && "group-hover/row:invisible group-focus-within/row:invisible",
                actions && actionsOpen && "invisible",
              )}
            >
              {trailing}
            </span>
          ) : null}
          {actions ? (
            <span
              className={cn(
                "absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
                actionsOpen && "opacity-100",
                !trailing && "relative",
              )}
            >
              {actions}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
});

export function Count({ value, strong }: { value: number; strong?: boolean }) {
  if (value <= 0) return null;
  return (
    <span className={cn("min-w-4 text-right text-xs tabular-nums", strong ? "text-sidebar-foreground" : "text-sidebar-muted-foreground")}>
      {value > 9999 ? "9999+" : value.toLocaleString()}
    </span>
  );
}

/** A tiny ghost button inside a row (hover chevron, "…"). */
export const RowIconButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(
  function RowIconButton({ label, className, children, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          "grid size-5 cursor-pointer place-items-center rounded-sm text-sidebar-muted-foreground outline-none hover:bg-white/10 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-3.5",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);

/** The inline name field for renaming or creating a group, label or account. */
export function InlineNameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
  leading,
  allowEmpty,
}: {
  initial: string;
  placeholder: string;
  onCommit(name: string): void;
  onCancel(): void;
  leading?: ReactNode;
  /** Commit an emptied name too (accounts then show their address). */
  allowEmpty?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = ref.current?.value.trim() ?? "";
    if (commit && (name || allowEmpty) && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <div className={cn(sidebarRowClass, "cursor-text bg-sidebar-row-selected text-sidebar-foreground ring-1 ring-ring/60 hover:bg-sidebar-row-selected")}>
      {leading}
      <input
        ref={ref}
        defaultValue={initial}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-placeholder"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") finish(true);
          if (event.key === "Escape") finish(false);
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}
