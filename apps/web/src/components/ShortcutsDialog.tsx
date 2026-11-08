import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { SHORTCUTS, type Shortcut } from "~/hooks/useKeyboard";
import { useUi } from "~/state/ui";

export function ShortcutsDialog() {
  const open = useUi((s) => s.dialog?.type === "shortcuts");
  const close = useUi((s) => s.closeDialog);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <div className="space-y-5">
              <ShortcutGroup group="General" />
              <ShortcutGroup group="Navigation" />
            </div>
            <ShortcutGroup group="Conversations" />
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function ShortcutGroup({ group }: { group: Shortcut["group"] }) {
  return (
    <section>
      <h3 className="mb-1.5 font-medium text-muted-foreground text-xs">{group}</h3>
      <ul className="space-y-0.5">
        {SHORTCUTS.filter((s) => s.group === group).map((s) => (
          <li key={s.label} className="flex h-7 items-center justify-between gap-4 text-sm">
            <span className="text-foreground/90">{s.label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {s.keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && s.keys[0] === "G" ? <span className="text-muted-foreground text-xs">then</span> : null}
                  <Kbd>{k}</Kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
