/**
 * New message, in T3 Code's dialog: From (accounts by group), To / Cc / Bcc, Subject, the
 * text, attachments; Discard, Save draft, Send (Ctrl+Enter). Closing with something written
 * keeps it as a draft.
 */
import type { Account, Draft } from "@fancy-mail/contracts";
import { SendHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountAvatar } from "~/components/common";
import { FieldSelect, type Choice } from "~/components/selects";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
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
import { AttachButton, AttachmentChips, QuoteFold, SaveStatus } from "./ComposerParts";
import { RecipientField, invalidAddresses } from "./RecipientField";
import { signatureText } from "./replyDefaults";
import { fieldsFromDraft, hasContent, useDraftEditor, type DraftFields } from "./useDraftEditor";

export function ComposeDialog() {
  const compose = useUi((s) => s.compose);
  const close = useUi((s) => s.closeCompose);
  const closingRef = useRef<(() => Promise<void>) | null>(null);
  const registerClose = useCallback((fn: (() => Promise<void>) | null) => {
    closingRef.current = fn;
  }, []);

  return (
    <Dialog
      open={!!compose}
      onOpenChange={(open) => {
        if (open) return;
        // Keep what was written: save it, then close.
        const flush = closingRef.current;
        if (flush) void flush().finally(close);
        else close();
      }}
    >
      <DialogPopup showCloseButton className="max-h-[min(46rem,calc(100vh-2rem))] w-[640px] max-w-[calc(100vw-2rem)] overflow-hidden">
        {compose ? <ComposeLoader key={compose.session} compose={compose} onRegisterClose={registerClose} onDone={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function ComposeLoader({
  compose,
  onRegisterClose,
  onDone,
}: {
  compose: ComposeState;
  onRegisterClose(fn: (() => Promise<void>) | null): void;
  onDone(): void;
}) {
  const [draft, setDraft] = useState<Draft | null | "loading">(compose.draftId ? "loading" : null);
  useEffect(() => {
    if (!compose.draftId) return;
    let alive = true;
    rpc("drafts.get", { draftId: compose.draftId })
      .then((d) => alive && setDraft(d))
      .catch((error) => {
        toast.error("Couldn't open the draft", errorMessage(error));
        onDone();
      });
    return () => {
      alive = false;
    };
  }, [compose.draftId, onDone]);

  if (draft === "loading") {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-5 w-40 rounded-full" />
        <Skeleton className="h-8 w-full rounded-lg" />
        <Skeleton className="h-8 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  return <ComposeForm compose={compose} draft={draft} onRegisterClose={onRegisterClose} onDone={onDone} />;
}

function accountChoices(accounts: Account[], groupName: (id: string | null) => string): Choice[] {
  return accounts.map((a) => ({
    value: a.id,
    label: a.displayName ? `${a.displayName} <${a.email}>` : a.email,
    icon: <AccountAvatar account={a} size={18} />,
    group: groupName(a.groupId),
  }));
}

function ComposeForm({
  compose,
  draft,
  onRegisterClose,
  onDone,
}: {
  compose: ComposeState;
  draft: Draft | null;
  onRegisterClose(fn: (() => Promise<void>) | null): void;
  onDone(): void;
}) {
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

  const editor = useDraftEditor(initial, { draftId: draft?.id ?? null });
  const { fields, update } = editor;
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    onRegisterClose(() => editor.flush());
    return () => onRegisterClose(null);
  }, [editor.flush, onRegisterClose]); // eslint-disable-line react-hooks/exhaustive-deps

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
      onDone();
    }
  };

  const discard = async () => {
    editor.close();
    await editor.discard();
    onDone();
  };

  const saveNow = async () => {
    try {
      await editor.save();
      toast.show({ title: "Draft saved", duration: 2500 });
      editor.close();
      onDone();
    } catch (error) {
      toast.error("Couldn't save the draft", errorMessage(error));
    }
  };

  return (
    <div
      className="flex min-h-0 flex-col"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void send();
        }
      }}
    >
      <div className="flex items-center px-5 pt-4 pb-2 pe-12">
        <DialogTitle className="text-base">{draft ? "Draft" : "New message"}</DialogTitle>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="divide-y divide-border/70 border-border/70 border-y px-5">
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
          className="min-h-56 w-full flex-1 resize-none bg-transparent px-5 py-3 text-sm leading-relaxed outline-none placeholder:text-placeholder"
        />
        <QuoteFold editor={editor} />
        <AttachmentChips editor={editor} className="px-5 pb-3" />
      </div>
      <div className={cn("flex items-center gap-2 border-t bg-muted/72 px-4 py-3")}>
        <AttachButton editor={editor} />
        <SaveStatus editor={editor} />
        <span className="ms-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void discard()}>
            Discard
          </Button>
          <Button variant="outline" size="sm" disabled={!hasContent(fields)} onClick={() => void saveNow()}>
            Save draft
          </Button>
          <Button size="sm" disabled={editor.sending || editor.uploading.length > 0 || !fields.accountId} onClick={() => void send()} title="Send (Ctrl+Enter)">
            {editor.sending ? <Spinner size="sm" /> : <SendHorizontalIcon />}
            Send
          </Button>
        </span>
      </div>
    </div>
  );
}
