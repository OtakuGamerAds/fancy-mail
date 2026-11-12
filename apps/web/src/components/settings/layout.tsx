/**
 * Settings building blocks after T3 Code's (components/settings/settingsLayout.tsx and
 * SettingsGroup.tsx, MIT License — see THIRD_PARTY_LICENSE_T3CODE.txt): a section title, a
 * grouped card, and rows with a title, a description and a control on the right.
 */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

export function SettingsGroup({ className, divided = true, ...props }: ComponentProps<"div"> & { divided?: boolean }) {
  return (
    <div
      data-slot="settings-group"
      {...props}
      className={cn(
        "relative overflow-visible rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5",
        divided && "[&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  plain,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  plain?: boolean;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4">
        <div className="min-w-0">
          <h2 className="flex min-h-7 items-center gap-2 font-semibold text-base text-foreground">{title}</h2>
          {description ? <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {action ? <div className="flex min-h-7 shrink-0 items-center justify-end">{action}</div> : null}
      </div>
      {plain ? children : <SettingsGroup>{children}</SettingsGroup>}
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  control,
  children,
  className,
  status,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
  status?: ReactNode;
}) {
  return (
    <div data-slot="settings-row" className={cn("@container/settings-row rounded-xl px-3 sm:px-4", children ? "pt-3 pb-3" : "py-3", className)}>
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_auto] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="flex min-h-5 items-center gap-1.5 font-medium text-foreground text-sm">{title}</h3>
          {description ? <p className="max-w-2xl text-pretty text-muted-foreground text-xs leading-normal">{description}</p> : null}
          {status ? <div className="pt-0.5 text-muted-foreground text-xs">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end @min-[32rem]/settings-row:[&_[data-slot=select-trigger]]:min-w-40">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** A command or snippet with a copy button; `wrap` for a sentence rather than code. */
export function CodeBlock({ code, label, action, wrap }: { code: string; label?: string; action?: ReactNode; wrap?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-black/40">
      {label || action ? (
        <div className="flex h-8 items-center justify-between gap-2 border-border/50 border-b ps-3 pe-1 text-muted-foreground text-xs">
          <span>{label}</span>
          {action}
        </div>
      ) : null}
      <pre
        className={cn("px-3 py-2.5 font-mono text-[12px] text-foreground/90 leading-relaxed", wrap ? "whitespace-pre-wrap break-words" : "overflow-x-auto")}
        data-selectable
      >
        {code}
      </pre>
    </div>
  );
}
