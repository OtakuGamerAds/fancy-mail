/**
 * Two ways to pick one of a few values: QuietSelect (a ghost trigger showing the choice in
 * short form, the way T3 Code puts its model picker beside the send button; from Fancy
 * Dictator) and FieldSelect (a full-width form select with optional descriptions).
 */
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { cn } from "~/lib/utils";

/** A long dropdown list scrolls after 8 rows, with a clearly visible scrollbar. */
export const SCROLL_LIST = "max-h-[min(19rem,var(--available-height))] [&::-webkit-scrollbar-thumb]:bg-white/20 hover:[&::-webkit-scrollbar-thumb]:bg-white/30";

export interface Choice<V extends string = string> {
  value: V;
  label: string;
  description?: string;
  icon?: ReactNode;
  group?: string;
}

export function QuietSelect<V extends string>({
  items,
  value,
  onChange,
  label,
  ariaLabel,
  side = "bottom",
  align = "start",
  disabled,
  className,
}: {
  items: Choice<V>[];
  value: V;
  onChange(value: V): void;
  /** What the trigger shows (defaults to the choice's label). */
  label?: ReactNode;
  ariaLabel: string;
  side?: "bottom" | "top";
  align?: "start" | "center" | "end";
  disabled?: boolean;
  className?: string;
}) {
  const current = items.find((i) => i.value === value);
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => next !== null && onChange(next as V)}>
      <SelectTrigger variant="ghost" size="xs" className={cn("w-auto min-w-0 shrink-0 font-medium", className)} aria-label={ariaLabel}>
        <SelectValue>{() => label ?? current?.label ?? ""}</SelectValue>
      </SelectTrigger>
      <SelectPopup side={side} align={align} alignItemWithTrigger={false} matchTriggerWidth={false} className={SCROLL_LIST}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="min-w-40">
            <span className="flex items-center justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2">
                {item.icon}
                <span className="truncate">{item.label}</span>
              </span>
              <SelectPrimitive.ItemIndicator>
                <CheckIcon className="size-4 text-foreground" />
              </SelectPrimitive.ItemIndicator>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function FieldSelect<V extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  id,
  className,
  size = "default",
  disabled,
  renderValue,
}: {
  items: Choice<V>[];
  value: V;
  onChange(value: V): void;
  ariaLabel?: string;
  id?: string;
  className?: string;
  size?: "default" | "sm" | "xs" | "compact";
  disabled?: boolean;
  renderValue?: (item: Choice<V> | undefined) => ReactNode;
}) {
  const current = items.find((i) => i.value === value);
  const groups = [...new Set(items.map((i) => i.group ?? ""))];
  const renderItem = (item: Choice<V>) => (
    <SelectItem key={item.value} value={item.value}>
      <span className="flex items-start justify-between gap-3 py-0.5">
        <span className="flex min-w-0 items-start gap-2">
          {item.icon ? <span className="flex h-5 shrink-0 items-center">{item.icon}</span> : null}
          <span className="min-w-0">
            <span className="block truncate">{item.label}</span>
            {item.description ? <span className="block text-muted-foreground text-xs">{item.description}</span> : null}
          </span>
        </span>
        <SelectPrimitive.ItemIndicator className="flex h-5 items-center">
          <CheckIcon className="size-4 text-foreground" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectItem>
  );
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => next !== null && onChange(next as V)}>
      <SelectTrigger id={id} size={size} className={className} aria-label={ariaLabel}>
        <SelectValue>
          {() =>
            renderValue ? (
              renderValue(current)
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                {current?.icon}
                <span className="truncate">{current?.label ?? ""}</span>
              </span>
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} className={SCROLL_LIST}>
        {groups.length > 1
          ? groups.map((group) => (
              <SelectGroup key={group || "_"}>
                {group ? <SelectGroupLabel>{group}</SelectGroupLabel> : null}
                {items.filter((i) => (i.group ?? "") === group).map(renderItem)}
              </SelectGroup>
            ))
          : items.map(renderItem)}
      </SelectPopup>
    </Select>
  );
}
