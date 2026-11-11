/**
 * After Send: "Sending… (14)" with a bar that empties, Undo and Send now. The wait itself is on
 * the server (it goes out even if the window closes); this only shows it. When it ends the
 * toast says Sending… until the server reports Sent (events.ts, same toast id).
 */
import type { Draft } from "@fancy-mail/contracts";
import { SendHorizontalIcon } from "lucide-react";

import { toast } from "~/components/ui/toast";
import { errorMessage, rpc } from "~/rpc/client";
import { qk, queryClient } from "~/state/queries";
import { useUi } from "~/state/ui";

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function refresh(draft: Draft): void {
  void queryClient.invalidateQueries({ queryKey: qk.drafts });
  void queryClient.invalidateQueries({ queryKey: qk.thread(draft.conversationId) });
}

function sending(id: string): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  toast.show({ id: `send-${id}`, type: "loading", title: "Sending…", duration: 0 });
}

export function showSendToast(draft: Draft): void {
  const id = draft.id;
  const left = draft.sendAt === null ? 0 : draft.sendAt - Date.now();
  if (left <= 0) {
    sending(id);
    return;
  }
  toast.show({
    id: `send-${id}`,
    type: "plain",
    title: "Sending…",
    duration: 0,
    countdown: { endsAt: draft.sendAt!, total: left },
    actions: [
      { label: "Undo", onClick: () => void undo(draft) },
      {
        label: "Send now",
        primary: true,
        closes: false,
        icon: <SendHorizontalIcon />,
        onClick: () => {
          sending(id);
          rpc("drafts.sendNow", { draftId: id }).catch((error) => toast.error("Couldn't send it now", errorMessage(error)));
        },
      },
    ],
  });
  // The wait ran out: it's going out now (the server says Sent when it's done).
  const timer = setTimeout(() => {
    timers.delete(id);
    sending(id);
  }, left);
  timers.set(id, timer);
}

async function undo(draft: Draft): Promise<void> {
  const timer = timers.get(draft.id);
  if (timer) clearTimeout(timer);
  timers.delete(draft.id);
  try {
    await rpc("drafts.cancelSend", { draftId: draft.id });
  } catch (error) {
    toast.show({ id: `send-${draft.id}`, type: "error", title: "Couldn't undo", description: errorMessage(error), duration: 6000 });
    return;
  }
  refresh(draft);
  toast.show({ id: `send-${draft.id}`, title: "Sending undone", duration: 3000 });
  // Back where it was being written.
  const ui = useUi.getState();
  if (draft.mode === "new") ui.openCompose({ draftId: draft.id, threadId: draft.conversationId, accountId: draft.accountId });
  else ui.requestReply(draft.conversationId, draft.mode, draft.id);
}
