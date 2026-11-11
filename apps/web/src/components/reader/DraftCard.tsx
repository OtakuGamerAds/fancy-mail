/**
 * An unsent draft in the conversation — often a reply an agent prepared for review. It says
 * who wrote it; Edit opens it in the reply box, Send sends it as it is, Discard deletes it.
 */
import type { Draft } from "@fancy-mail/contracts";
import { PencilIcon, SendHorizontalIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { showSendToast } from "~/components/compose/sendToast";
import { toast } from "~/components/ui/toast";
import { displayName } from "~/lib/addresses";
import { actorLabel } from "~/lib/agents";
import { formatRelative } from "~/lib/format";
import { splitDraftBody } from "~/lib/plainText";
import { textDirection } from "~/lib/textDirection";
import { errorMessage, rpc } from "~/rpc/client";
import { qk, queryClient } from "~/state/queries";
import { useUi } from "~/state/ui";

export function DraftCard({ draft, threadId }: { draft: Draft; threadId: string }) {
  const [busy, setBusy] = useState<"send" | "discard" | null>(null);
  const byAgent = draft.createdBy.kind === "agent";
  const { text } = splitDraftBody(draft.bodyText);
  const preview = text.trim();
  const recipients = [...draft.to, ...draft.cc].map((a) => displayName(a)).join(", ");
  const inFlight = draft.sendState === "queued" || draft.sendState === "sending";

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: qk.thread(threadId) });
    void queryClient.invalidateQueries({ queryKey: qk.drafts });
  };

  const send = async () => {
    setBusy("send");
    try {
      showSendToast(await rpc("drafts.send", { draftId: draft.id, undoable: true }));
      refresh();
    } catch (error) {
      toast.error("Couldn't send the draft", errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy("discard");
    try {
      await rpc("drafts.delete", { draftId: draft.id });
      refresh();
      toast.show({ title: "Draft discarded", duration: 3000 });
    } catch (error) {
      toast.error("Couldn't discard the draft", errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="rounded-2xl border border-dashed border-white/[0.12] bg-message/60 px-4 py-3">
      <header className="flex flex-wrap items-center gap-2">
        {byAgent ? (
          <Badge variant="info" size="lg" className="gap-1">
            <SparklesIcon />
            Draft by {actorLabel(draft.createdBy)}
          </Badge>
        ) : (
          <Badge variant="secondary" size="lg">
            Your draft
          </Badge>
        )}
        {draft.sendState === "failed" ? (
          <Badge variant="error" size="lg">
            Not sent
          </Badge>
        ) : null}
        {recipients ? <span className="min-w-0 truncate text-muted-foreground text-xs">to {recipients}</span> : null}
        <span className="ms-auto shrink-0 text-muted-foreground text-xs">{formatRelative(draft.updatedAt)}</span>
      </header>
      {draft.sendState === "failed" && draft.sendError ? (
        <p className="mt-2 text-destructive-foreground text-xs">{draft.sendError}</p>
      ) : null}
      {preview ? (
        <p
          dir={textDirection(preview)}
          className="mt-2 line-clamp-6 whitespace-pre-wrap wrap-anywhere text-start text-[14px] text-foreground/90 leading-relaxed"
          data-selectable
        >
          {preview}
        </p>
      ) : (
        <p className="mt-2 text-muted-foreground text-sm italic">Empty draft</p>
      )}
      {draft.attachments.length > 0 ? (
        <p className="mt-1.5 text-muted-foreground text-xs">
          {draft.attachments.map((a) => a.filename).join(", ")}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={inFlight || busy !== null}
          onClick={() =>
            draft.mode === "new"
              ? useUi.getState().openCompose({ draftId: draft.id, threadId: draft.conversationId, accountId: draft.accountId })
              : useUi.getState().requestReply(threadId, draft.mode, draft.id)
          }
        >
          <PencilIcon />
          Edit
        </Button>
        <Button size="sm" disabled={inFlight || busy !== null} onClick={() => void send()}>
          {busy === "send" || inFlight ? <Spinner size="sm" /> : <SendHorizontalIcon />}
          {inFlight ? "Sending…" : "Send"}
        </Button>
        <Button size="sm" variant="ghost-destructive" disabled={inFlight || busy !== null} onClick={() => void discard()}>
          {busy === "discard" ? <Spinner size="sm" /> : <Trash2Icon />}
          Discard
        </Button>
      </div>
    </article>
  );
}
