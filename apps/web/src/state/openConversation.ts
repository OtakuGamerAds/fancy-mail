/**
 * Opening a row of the list. A new message that is still a draft opens in the composer (where
 * it is written); anything else opens in the reader.
 */
import type { Draft } from "@fancy-mail/contracts";

import { rpc } from "~/rpc/client";
import { qk, queryClient, type ThreadStates } from "./queries";
import { navigate } from "./router";
import { useUi } from "./ui";

/** The unsent new message a list row stands for, if it is one. */
export function newMessageDraft(threadId: string, drafts?: Draft[]): Draft | undefined {
  const list = drafts ?? queryClient.getQueryData<Draft[]>(qk.drafts) ?? [];
  return list.find(
    (d) => d.mode === "new" && d.conversationId === threadId && (d.sendState === "draft" || d.sendState === "failed"),
  );
}

export function openConversation(threadId: string): void {
  const ui = useUi.getState();
  ui.setFocusedThread(threadId);
  const draft = newMessageDraft(threadId);
  if (draft) {
    ui.openCompose({ draftId: draft.id, threadId, accountId: draft.accountId });
    return;
  }
  const route = ui.route;
  if (route.page === "mail") navigate({ ...route, threadId });
  // Seen: "Replied", "No reply" or "Woke" on its row goes.
  if (queryClient.getQueryData<ThreadStates>(qk.threadStates)?.marks.has(threadId)) {
    void rpc("threads.clearMark", { threadId }).catch(() => {});
  }
}
