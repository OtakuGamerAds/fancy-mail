/**
 * A new message, written where a conversation is read (not in a dialog): From, To / Cc / Bcc,
 * Subject, the text, attachments; Discard and Send (Ctrl+Enter). Nothing is kept until
 * something is written; from then on it saves itself as a draft, which shows up in the list.
 * Closing it, or opening a conversation, keeps what was written.
 */
import type { Account, Draft } from "@fancy-mail/contracts";
import { ArrowLeftIcon, SendHorizontalIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AccountAvatar, IconButton } from "~/components/common";
import { FieldSelect, type Choice } from "~/components/selects";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { toast } from "~/components/ui/toast";
import { parseAddressList } from "~/lib/addresses";
import { splitDraftBody } from "~/lib/plainText";
import { textDirection } from "~/lib/textDirection";
import { cn } from "~/lib/utils";
import { errorMessage, rpc } from "~/rpc/client";
import { useBootstrap, useDirectory } from "~/state/queries";
import { useUi, type ComposeState } from "~/state/ui";
import { describeView } from "~/state/view";
import { AttachButton, AttachmentChips, COMPOSER_SURFACE, QuoteFold, SaveStatus } from "./ComposerParts";
import { RecipientField, invalidAddresses } from "./RecipientField";
import { signatureText } from "./replyDefaults";
import { fieldsFromDraft, hasContent, useDraftEditor, type DraftFields } from "./useDraftEditor";

export function ComposePane({ compose, fullWidth }: { compose: ComposeState; fullWidth: boolean }) {
  return <ComposeLoader key={compose.session} compose={compose} fullWidth={fullWidth} />;
}

function close() {
  useUi.getState().closeCompose();
}

/** The header strip: the window's title bar here, as in the reader. */
function PaneStrip({ title, fullWidth, onClose, children }: { title: string; fullWidth: boolean; onClose(): void; children?: React.ReactNode }) {
  return (
    <div
      data-drag-region
      className="app-drag flex h-[var(--header-height)] shrink-0 items-center gap-2 ps-5"
      style={{ paddingInlineEnd: "calc(var(--wco-inset) + 0.75rem)" }}
    >
      {fullWidth ? (
        <IconButton label="Back to the list" shortcut="Esc" onClick={onClose} className="-ms-2">
          <ArrowLeftIcon />
        </IconButton>
      ) : null}
      <h1 className="min-w-0 truncate font-semibold text-[15px] text-foreground tracking-tight" dir="auto">
        {title}
      </h1>
      <span className="flex-1" />
      {children}
      <IconButton label="Close" shortcut="Esc" onClick={onClose}>
        <XIcon />
      </IconButton>
    </div>
  );
}

function ComposeLoader({ compose, fullWidth }: { compose: ComposeState; fullWidth: boolean }) {
  const [draft, setDraft] = useState<Draft | null | "loading">(compose.draftId ? "loading" : null);
  useEffect(() => {
    if (!compose.draftId) return;
    let alive = true;
    rpc("drafts.get", { draftId: compose.draftId })
      .then((d) => alive && setDraft(d))
      .catch((error) => {
        toast.error("Couldn't open the draft", errorMessage(error));
        close();
      });
    return () => {
      alive = false;
    };
  }, [compose.draftId]);

  if (draft === "loading") {
    return (
      <div className="flex h-full flex-col">
        <PaneStrip title="Draft" fullWidth={fullWidth} onClose={close} />
        <div className="mx-auto w-full max-w-[52rem] space-y-3 px-5 pt-2">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
      </div>
    );
  }
  return <ComposeForm compose={compose} draft={draft} fullWidth={fullWidth} />;
}

function accountChoices(accounts: Account[], groupName: (id: string | null) => string): Choice[] {
  return accounts.map((a) => ({
    value: a.id,
    label: a.displayName ? `${a.displayName} <${a.email}>` : a.email,
    icon: <AccountAvatar account={a} size={18} />,
    group: groupName(a.groupId),
  }));
}

function ComposeForm({ compose, draft, fullWidth }: { compose: ComposeState; draft: Draft | null; fullWidth: boolean }) {
  const { data: bootstrap } = useBootstrap();
  const dir = useDirectory();
  const route = useUi((s) => s.route);

  const sendable = dir.accounts;
  const defaultAccountId = useMemo(() => {
    if (compose.accountId && dir.accountById.has(compose.accountId)) return compose.accountId;
    if (route.page === "mail") {
      const id = describeView(route.view, bootstrap).defaultAccountId;
      if (id) return id;
    }
    return sendable[0]?.id ?? "";
  }, [compose.accountId, route, bootstrap, dir.accountById, sendable]);

  const [initial] = useState<DraftFields>(() => {
    if (draft) return fieldsFromDraft(draft, splitDraftBody);
    const account = dir.accountById.get(defaultAccountId);
    return {
      accountId: defaultAccountId,
      mode: "new",
      threadId: null,
      sourceMessageId: null,
      to: compose.to ? parseAddressList(compose.to).map((p) => p.address) : [],
      cc: [],
      bcc: [],
      subject: compose.subject ?? "",
      text: signatureText(account),
      quote: null,
      attachments: [],
    };
  });

  const session = compose.session;
  const editor = useDraftEditor(initial, {
    draftId: draft?.id ?? null,
    // Once saved it is a draft in the list: mark its row as the one open here.
    onSaved: (saved) => {
      const current = useUi.getState().compose;
      if (current?.session === session && current.threadId !== saved.conversationId) useUi.getState().setComposeThread(saved.conversationId);
    },
  });
  const { fields, update } = editor;
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Leaving (another conversation opened, the pane closed): keep what was written.
  const flush = editor.flush;
  useEffect(() => () => void flush(), [flush]);

  useEffect(() => {
    if (initial.to.length > 0) {
      textRef.current?.focus();
      textRef.current?.setSelectionRange(0, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupName = (id: string | null) => (id ? dir.groupById.get(id)?.name ?? "" : dir.groups.length > 0 ? "Ungrouped" : "");
  const choices = accountChoices(sendable, groupName);

  const send = async () => {
    const bad = invalidAddresses([...fields.to, ...fields.cc, ...fields.bcc]);
    if (bad.length > 0) {
      toast.error("Some addresses don't look right", bad.map((a) => a.address).join(", "));
      return;
    }
    if (await editor.send()) {
      editor.close();
      close();
    }
  };

  const discard = async () => {
    const hadDraft = editor.draftId() !== null;
    editor.close();
    await editor.discard();
    close();
    if (hadDraft) toast.show({ title: "Draft discarded", duration: 2500 });
  };

  const closeKeeping = async () => {
    await editor.flush();
    editor.close();
    close();
  };

  const title = fields.subject.trim() || (draft ? "Draft" : "New message");

  return (
    <div
      className="flex h-full min-w-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void send();
        } else if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("[data-slot=select-popup], [data-slot=popover-popup]")) {
          event.preventDefault();
          void closeKeeping();
        }
      }}
    >
      <PaneStrip title={title} fullWidth={fullWidth} onClose={() => void closeKeeping()}>
        <SaveStatus editor={editor} />
      </PaneStrip>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col px-5 pt-1 pb-6">
          <div className={cn(COMPOSER_SURFACE, "flex min-h-[28rem] flex-1 animate-enter flex-col")}>
            <div className="divide-y divide-border/70 border-border/70 border-b px-4">
              <div className="flex min-h-10 items-center gap-1 py-1">
                <span className="w-14 shrink-0 text-muted-foreground text-sm">From</span>
                {choices.length > 0 ? (
                  <FieldSelect
                    items={choices}
                    value={fields.accountId}
                    onChange={(accountId) => {
                      const previous = dir.accountById.get(fields.accountId);
                      const next = dir.accountById.get(accountId);
                      // Swap the signature when it is still the one that was put in.
                      const oldSig = signatureText(previous);
                      const text = oldSig && fields.text.endsWith(oldSig) ? fields.text.slice(0, -oldSig.length) + signatureText(next) : fields.text;
                      update({ accountId, text });
                    }}
                    ariaLabel="From"
                    size="sm"
                    className="w-auto max-w-full min-w-0 border-transparent bg-transparent shadow-none dark:bg-transparent hover:bg-accent"
                  />
                ) : (
                  <span className="text-muted-foreground text-sm">Add an account first.</span>
                )}
              </div>
              <RecipientField
                label="To"
                value={fields.to}
                onChange={(to) => update({ to })}
                autoFocus={initial.to.length === 0}
                placeholder="Name or address"
                trailing={
                  <>
                    {!showCc ? (
                      <button type="button" className="cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground" onClick={() => setShowCc(true)}>
                        Cc
                      </button>
                    ) : null}
                    {!showBcc ? (
                      <button type="button" className="cursor-pointer rounded px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground" onClick={() => setShowBcc(true)}>
                        Bcc
                      </button>
                    ) : null}
                  </>
                }
              />
              {showCc ? <RecipientField label="Cc" value={fields.cc} onChange={(cc) => update({ cc })} autoFocus={fields.cc.length === 0} /> : null}
              {showBcc ? <RecipientField label="Bcc" value={fields.bcc} onChange={(bcc) => update({ bcc })} autoFocus={fields.bcc.length === 0 && !showCc} /> : null}
              <label className="flex min-h-10 items-center gap-1">
                <span className="w-14 shrink-0 text-muted-foreground text-sm">Subject</span>
                <input
                  value={fields.subject}
                  onChange={(event) => update({ subject: event.target.value })}
                  aria-label="Subject"
                  dir="auto"
                  className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
                />
              </label>
            </div>
            <textarea
              ref={textRef}
              value={fields.text}
              onChange={(event) => update({ text: event.target.value })}
              aria-label="Message"
              placeholder="Write your message"
              dir={textDirection(fields.text) === "rtl" ? "rtl" : "auto"}
              className="min-h-56 w-full flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-placeholder"
            />
            <QuoteFold editor={editor} />
            <AttachmentChips editor={editor} className="px-4 pb-3" />
            <div className="flex items-center gap-2 border-border/70 border-t px-3 py-2.5">
              <AttachButton editor={editor} />
              <span className="ms-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => void discard()} title={hasContent(fields) ? "Delete this draft" : "Close"}>
                  <Trash2Icon />
                  Discard
                </Button>
                <Button size="sm" disabled={editor.sending || editor.uploading.length > 0 || !fields.accountId} onClick={() => void send()} title="Send (Ctrl+Enter)">
                  {editor.sending ? <Spinner size="sm" /> : <SendHorizontalIcon />}
                  Send
                </Button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
