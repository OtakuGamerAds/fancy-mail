/**
 * A message's body. HTML: sanitized, in a sandboxed iframe (no scripts, ever) on a white
 * rounded "paper", sized to its content; remote images wait behind "Show images". Plain text:
 * in the app's own type, links clickable, quoted history folded, direction per paragraph.
 */
import type { Message } from "@fancy-mail/contracts";
import { ImageOffIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { InlineButton } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { openExternal } from "~/lib/desktop";
import { linkify, paragraphs, splitQuotedTail } from "~/lib/plainText";
import { sanitizeEmailHtml, senderAllowsImages } from "~/lib/sanitize";
import { textDirection } from "~/lib/textDirection";
import { cn } from "~/lib/utils";
import { updateSettings } from "~/state/actions";
import { useBootstrap } from "~/state/queries";
import { openMailto } from "./mailto";

export function EmailBody({ message }: { message: Message }) {
  if (!message.body) return <BodySkeleton />;
  if (message.body.html) return <HtmlBody message={message} html={message.body.html} />;
  if (message.body.text) return <PlainBody text={message.body.text} />;
  return <p className="text-muted-foreground text-sm italic">This message has no text.</p>;
}

function BodySkeleton() {
  return (
    <div className="space-y-2.5 py-1" aria-busy aria-label="Loading the message">
      <Skeleton className="h-3 w-11/12 rounded-full" />
      <Skeleton className="h-3 w-4/5 rounded-full" />
      <Skeleton className="h-3 w-9/12 rounded-full" />
      <Skeleton className="h-3 w-2/5 rounded-full" />
    </div>
  );
}

// ── HTML ────────────────────────────────────────────────────────────────────────────────────

function HtmlBody({ message, html }: { message: Message; html: string }) {
  const { data: bootstrap } = useBootstrap();
  const settings = bootstrap?.settings;
  const sender = message.from?.address ?? null;
  const [shownHere, setShownHere] = useState(false);
  const allowRemote =
    shownHere || settings?.remoteImages === "always" || senderAllowsImages(sender, settings?.allowedImageSenders ?? []);

  const sanitized = useMemo(
    () => sanitizeEmailHtml(html, { messageId: message.id, allowRemote }),
    [html, message.id, allowRemote],
  );

  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    let doc: Document | null = null;

    const measure = () => {
      const d = frame.contentDocument;
      if (!d?.documentElement) return;
      const scrollbar = d.documentElement.scrollWidth > d.documentElement.clientWidth ? 12 : 0;
      const next = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0) + scrollbar;
      setHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        // An anchor inside the email: scroll to it there.
        frame.contentDocument?.getElementById(href.slice(1))?.scrollIntoView();
        return;
      }
      if (/^mailto:/i.test(href)) {
        openMailto(href);
        return;
      }
      if (/^https?:/i.test(link.href)) openExternal(link.href);
    };

    const onLoad = () => {
      doc = frame.contentDocument;
      if (!doc) return;
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      if (doc.body) observer.observe(doc.body);
      observer.observe(doc.documentElement);
      doc.addEventListener("click", onClick);
      // Late images change the height.
      doc.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure, { once: true }));
    };

    frame.addEventListener("load", onLoad);
    if (frame.contentDocument?.readyState === "complete") onLoad();
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
      doc?.removeEventListener("click", onClick);
    };
  }, [sanitized.document]);

  const blocked = !allowRemote && sanitized.blockedImages > 0;

  return (
    <div className="space-y-2">
      {blocked ? (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-white/[0.04] px-3 py-1.5 text-muted-foreground text-xs">
          <ImageOffIcon className="size-3.5 shrink-0" />
          <span>Images are hidden.</span>
          <span aria-hidden>·</span>
          <InlineButton className="text-xs" onClick={() => setShownHere(true)}>
            Show images
          </InlineButton>
          {sender ? (
            <>
              <span aria-hidden>·</span>
              <InlineButton
                tone="muted"
                className="max-w-full truncate text-xs"
                onClick={() => {
                  const allowed = settings?.allowedImageSenders ?? [];
                  void updateSettings({ allowedImageSenders: [...new Set([...allowed, sender.toLowerCase()])] });
                }}
              >
                Always for {sender}
              </InlineButton>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-xl bg-white p-5">
        <iframe
          ref={frameRef}
          title={`Message from ${message.from?.name ?? message.from?.address ?? "unknown sender"}`}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={sanitized.document}
          referrerPolicy="no-referrer"
          className="block w-full border-0 bg-white"
          style={{ height }}
        />
      </div>
    </div>
  );
}

// ── Plain text ──────────────────────────────────────────────────────────────────────────────

function Linked({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((token, i) =>
        token.kind === "text" ? (
          <span key={i}>{token.value}</span>
        ) : (
          <a
            key={i}
            href={token.href}
            className="text-info-foreground underline decoration-info-foreground/40 underline-offset-2 hover:decoration-info-foreground"
            onClick={(event) => {
              event.preventDefault();
              if (token.href.startsWith("mailto:")) openMailto(token.href);
              else openExternal(token.href);
            }}
          >
            {token.value}
          </a>
        ),
      )}
    </>
  );
}

function Paragraphs({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div className={cn("space-y-3 whitespace-pre-wrap wrap-anywhere text-[14px] leading-relaxed", muted ? "text-muted-foreground" : "text-foreground/95")}>
      {paragraphs(text).map((p, i) => (
        <p key={i} dir={textDirection(p)} className="text-start">
          <Linked text={p} />
        </p>
      ))}
    </div>
  );
}

export function PlainBody({ text }: { text: string }) {
  const { body, quote } = useMemo(() => splitQuotedTail(text), [text]);
  const [open, setOpen] = useState(false);
  return (
    <div data-selectable className="select-text">
      <Paragraphs text={body} />
      {quote ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title={open ? "Hide the quoted text" : "Show the quoted text"}
            className="inline-flex h-5 cursor-pointer items-center rounded-full bg-white/[0.06] px-2 text-muted-foreground text-xs leading-none hover:bg-white/10 hover:text-foreground"
          >
            ···
          </button>
          {open ? (
            <div className="mt-2 border-border border-l-2 ps-3">
              <Paragraphs text={quote} muted />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
