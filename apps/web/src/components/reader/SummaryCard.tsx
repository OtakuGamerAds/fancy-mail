/**
 * What an agent wrote about the conversation, above its messages: the whole thread at a
 * glance. Fancy Mail has no AI of its own; the user's agent writes it (mail_summary), in the
 * form the user asked for. It says who wrote it and when, and when newer mail came since.
 */
import type { AiSummary } from "@fancy-mail/contracts";
import { SparklesIcon, XIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { IconButton } from "~/components/common";
import { toast } from "~/components/ui/toast";
import { actorLabel } from "~/lib/agents";
import { formatRelative } from "~/lib/format";
import { parseSummary, type SummaryInline } from "~/lib/summaryText";
import { textDirection } from "~/lib/textDirection";
import { errorMessage, rpc } from "~/rpc/client";
import { qk, queryClient } from "~/state/queries";

function Inline({ parts }: { parts: SummaryInline[] }) {
  return (
    <>
      {parts.map((part, i) =>
        part.bold ? (
          <strong key={i} className="font-semibold text-foreground">
            {part.text}
          </strong>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

const plainText = (parts: SummaryInline[]) => parts.map((p) => p.text).join("");

export function SummaryCard({ summary, threadId, lastMessageAt }: { summary: AiSummary; threadId: string; lastMessageAt: number }) {
  const [busy, setBusy] = useState(false);
  const blocks = useMemo(() => parseSummary(summary.text), [summary.text]);
  const stale = summary.at < lastMessageAt;
  const by = summary.by.kind === "agent" ? actorLabel(summary.by) : summary.by.kind === "user" ? "you" : "Fancy Mail";

  const remove = async () => {
    setBusy(true);
    try {
      await rpc("threads.setSummary", { threadId, text: null });
      void queryClient.invalidateQueries({ queryKey: qk.thread(threadId) });
      toast.show({ title: "Summary removed", description: "Your agent can write a new one.", duration: 3000 });
    } catch (error) {
      toast.error("Couldn't remove the summary", errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <section aria-label="Summary" data-summary className="rounded-2xl border border-info/20 bg-info/[0.06] ps-4 pe-2 pt-2.5 pb-3">
      <header className="flex items-center gap-2">
        <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-info-foreground" />
        <span className="font-medium text-info-foreground text-xs">Summary</span>
        <span className="min-w-0 truncate text-muted-foreground text-xs" title={new Date(summary.at).toLocaleString()}>
          by {by} · {formatRelative(summary.at)}
          {stale ? " · newer mail came since" : ""}
        </span>
        <span className="flex-1" />
        <IconButton label="Remove summary" size="icon-xs" disabled={busy} onClick={() => void remove()}>
          <XIcon />
        </IconButton>
      </header>
      <div className="mt-1.5 space-y-2 pe-2 text-[14px] text-foreground/90 leading-relaxed wrap-anywhere" data-selectable>
        {blocks.map((block, i) =>
          block.kind === "paragraph" ? (
            <p key={i} dir={textDirection(block.lines.map(plainText).join(" "))} className="text-start">
              {block.lines.map((line, j) => (
                <Fragment key={j}>
                  {j > 0 ? <br /> : null}
                  <Inline parts={line} />
                </Fragment>
              ))}
            </p>
          ) : block.ordered ? (
            <ol key={i} dir={textDirection(block.items.map(plainText).join(" "))} className="list-decimal space-y-0.5 ps-5 text-start">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline parts={item} />
                </li>
              ))}
            </ol>
          ) : (
            <ul key={i} dir={textDirection(block.items.map(plainText).join(" "))} className="list-disc space-y-0.5 ps-5 text-start marker:text-muted-foreground">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline parts={item} />
                </li>
              ))}
            </ul>
          ),
        )}
      </div>
    </section>
  );
}
