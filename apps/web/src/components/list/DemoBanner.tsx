import { FlaskConicalIcon } from "lucide-react";
import { useState } from "react";

import { InlineButton } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { errorMessage, rpc } from "~/rpc/client";
import { refreshBootstrap } from "~/state/actions";
import { qk, queryClient } from "~/state/queries";
import { useUi } from "~/state/ui";

export async function removeDemoMail() {
  try {
    await rpc("demo.remove", {});
    refreshBootstrap();
    void queryClient.invalidateQueries({ queryKey: qk.threadsAll });
    toast.show({ title: "Demo mail removed", duration: 3500 });
  } catch (error) {
    toast.error("Couldn't remove the demo mail", errorMessage(error));
  }
}

/** A slim line above the list while the demo accounts are there. */
export function DemoBanner() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-border border-b bg-info/[0.06] px-3 py-1.5 text-muted-foreground text-xs">
      <span className="flex min-w-0 items-center gap-1.5">
        <FlaskConicalIcon className="size-3.5 shrink-0 text-info-foreground" />
        <span>This is demo mail, so you can look around.</span>
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-1.5">
      <InlineButton className="text-xs" onClick={() => useUi.getState().openDialog({ type: "add-account" })}>
        Add your account
      </InlineButton>
      <span aria-hidden>·</span>
      <InlineButton
        tone="muted"
        className="text-xs"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await removeDemoMail();
          setBusy(false);
        }}
      >
        Remove demo mail
      </InlineButton>
      </span>
    </div>
  );
}
