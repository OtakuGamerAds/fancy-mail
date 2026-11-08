/**
 * Toasts with T3 Code's look (components/ui/toast.tsx: the dropdown-glass card, the corner
 * dismiss orb, xs action buttons; MIT License — see THIRD_PARTY_LICENSE_T3CODE.txt), on a
 * small store of their own: a stack at the bottom right, newest at the bottom, paused while
 * the pointer is over it.
 */
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { buttonVariants } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

export type ToastType = "info" | "success" | "error" | "agent" | "loading" | "plain";

export interface ToastAction {
  label: string;
  onClick(): void;
  /** Close the toast after the action (default true). */
  closes?: boolean;
  primary?: boolean;
}

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  description?: string | undefined;
  actions?: ToastAction[] | undefined;
  /** ms; 0 keeps it until dismissed. */
  duration: number;
  createdAt: number;
}

interface ToastStore {
  toasts: ToastItem[];
  add(toast: ToastItem): void;
  update(id: string, patch: Partial<ToastItem>): void;
  remove(id: string): void;
}

const useToasts = create<ToastStore>()((set) => ({
  toasts: [],
  add: (toast) => set((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== toast.id), toast].slice(-4) })),
  update: (id, patch) => set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

let counter = 0;

export const toast = {
  show(input: Partial<Omit<ToastItem, "createdAt">> & { title: string }): string {
    const id = input.id ?? `toast-${++counter}`;
    useToasts.getState().add({
      id,
      type: input.type ?? "plain",
      title: input.title,
      description: input.description,
      actions: input.actions,
      duration: input.duration ?? (input.type === "error" ? 8000 : 6000),
      createdAt: Date.now(),
    });
    return id;
  },
  error(title: string, description?: string): string {
    return toast.show({ type: "error", title, description });
  },
  success(title: string, description?: string): string {
    return toast.show({ type: "success", title, description });
  },
  update(id: string, patch: Partial<ToastItem>) {
    useToasts.getState().update(id, { ...patch, createdAt: Date.now() });
  },
  dismiss(id: string) {
    useToasts.getState().remove(id);
  },
};

const ICONS = {
  info: InfoIcon,
  success: CircleCheckIcon,
  error: CircleAlertIcon,
  agent: SparklesIcon,
} as const;

function ToastCard({ item, paused }: { item: ToastItem; paused: boolean }) {
  const remaining = useRef(item.duration);
  const startedAt = useRef(Date.now());

  // A changed toast (same id, new text) starts its time again.
  useEffect(() => {
    remaining.current = item.duration;
  }, [item.createdAt, item.duration]);

  useEffect(() => {
    if (item.duration <= 0) return;
    if (paused) return;
    startedAt.current = Date.now();
    const timer = setTimeout(() => toast.dismiss(item.id), Math.max(400, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, item.id, item.duration, item.createdAt]);

  const Icon = item.type === "loading" || item.type === "plain" ? null : ICONS[item.type];
  return (
    <div
      role={item.type === "error" ? "alert" : "status"}
      data-type={item.type}
      className="dropdown-glass pointer-events-auto relative w-full rounded-lg text-popover-foreground shadow-xl shadow-black/25 transition-[opacity,translate] duration-300 ease-out starting:translate-y-3 starting:opacity-0"
    >
      <div className="absolute -top-1.5 -right-1.5 z-20">
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => toast.dismiss(item.id)}
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm transition-[color,background-color] hover:bg-popover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <XIcon className="size-3" strokeWidth={2.25} />
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 py-3 ps-3.5 pe-3 text-sm">
        <div className="flex min-w-0 gap-2">
          {item.type === "loading" ? (
            <span className="flex h-lh w-4 shrink-0 items-center justify-center">
              <Spinner size="md" tone="muted" />
            </span>
          ) : Icon ? (
            <span className="flex h-lh w-4 shrink-0 items-center justify-center">
              <Icon
                className={cn(
                  "size-4",
                  item.type === "error" && "text-destructive",
                  item.type === "success" && "text-success",
                  item.type === "info" && "text-info",
                  item.type === "agent" && "text-update-foreground",
                )}
              />
            </span>
          ) : null}
          <div className="min-w-0">
            <div className="min-w-0 font-medium wrap-break-word">{item.title}</div>
            {item.description ? (
              <div className="mt-0.5 line-clamp-4 text-muted-foreground text-xs wrap-break-word">{item.description}</div>
            ) : null}
          </div>
        </div>
        {item.actions?.length ? (
          <div className="flex shrink-0 items-center gap-1">
            {item.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className={cn(buttonVariants({ size: "xs", variant: action.primary ? "default" : "outline" }))}
                onClick={() => {
                  action.onClick();
                  if (action.closes !== false) toast.dismiss(item.id);
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const [paused, setPaused] = useState(false);
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-3"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} paused={paused} />
      ))}
    </div>
  );
}
