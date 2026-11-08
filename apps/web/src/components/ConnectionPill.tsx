/** T3 Code's quiet status pill at the bottom while the connection to the server is down. */
import { Spinner } from "~/components/ui/spinner";
import { useDelayed } from "~/hooks/useDelayed";
import { useLive } from "~/state/events";

export function ConnectionPill() {
  const connection = useLive((s) => s.connection);
  const down = connection !== "open";
  // A brief blip (or the first connect) shows nothing.
  const visible = useDelayed(down, connection === "reconnecting" ? 600 : 2500);
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex justify-center">
      <div
        role="status"
        className="surface-glass pointer-events-auto flex h-8 items-center gap-2 rounded-full border border-border/60 px-3.5 text-muted-foreground text-xs shadow-lg shadow-black/40"
      >
        <Spinner size="xs" tone="muted" />
        {connection === "reconnecting" ? "Reconnecting…" : "Connecting to Fancy Mail…"}
      </div>
    </div>
  );
}
