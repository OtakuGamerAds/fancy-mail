/**
 * The reply box under a conversation, on T3 Code's composer surface. Closed: Reply · Reply all
 * · Forward. Open: who it goes to (click to edit), an autosizing text area, the mode picker,
 * the account it is sent from, attach, and Send (Ctrl+Enter). Autosaves as a draft.
 */
import type { Draft, DraftMode, ThreadDetail } from "@fancy-mail/contracts";
import { ForwardIcon, ReplyAllIcon, ReplyIcon, SendHorizontalIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AccountAvatar, IconButton } from "~/components/common";
import { QuietSelect } from "~/components/selects";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { displayName } from "~/lib/addresses";
import { splitDraftBody } from "~/lib/plainText";
import { textDirection } from "~/lib/textDirection";
import { cn } from "~/lib/utils";
import { useDirectory } from "~/state/queries";
import { useUi } from "~/state/ui";
import { AttachButton, AttachmentChips, COMPOSER_SURFACE, QuoteFold, SaveStatus } from "./ComposerParts";
import { RecipientField, invalidAddresses } from "./RecipientField";
import { replyFields } from "./replyDefaults";
import { fieldsFromDraft, hasContent, useDraftEditor, type DraftFields } from "./useDraftEditor";

type ReplyMode = Exclude<DraftMode, "new">;

const MODES: { value: ReplyMode; label: string; icon: React.ReactNode }[] = [
  { value: "reply", label: "Reply", icon: <ReplyIcon className="size-4" /> },
  { value: "replyAll", label: "Reply all", icon: <ReplyAllIcon className="size-4" /> },
  { value: "forward", label: "Forward", icon: <ForwardIcon className="size-4" /> },
];

interface OpenState {
  mode: ReplyMode;
  draft: Draft | null;
  key: number;
}

export function ReplyArea({ detail }: { detail: ThreadDetail }) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const request = useUi((s) => s.replyRequest);
  const clearRequest = useUi((s) => s.clearReplyRequest);
  const threadId = detail.thread.id;

  // r / a / f, and Edit on a draft card.
  useEffect(() => {
    if (!request || request.threadId !== threadId) return;
    clearRequest();
    const draft = request.draftId ? detail.drafts.find((d) => d.id === request.draftId) ?? null : null;
    setOpen({ mode: draft && draft.mode !== "new" ? draft.mode : request.mode, draft, key: request.nonce });
  }, [request, threadId, detail.drafts, clearRequest]);

  // A different conversation starts closed.
  useEffect(() => {
    setOpen(null);
  }, [threadId]);

  if (!open) {
    return (
      <div className="flex items-center justify-center gap-2 py-2">
        {MODES.map((m) => (
          <Button
            key={m.value}
            variant="outline"
            size="sm"
            className="rounded-full px-3.5 before:rounded-full"
            onClick={() => setOpen({ mode: m.value, draft: null, key: Date.now() })}
          >
            {m.icon}
            {m.label}
          </Button>
        ))}
      </div>
    );
  }
  return <ReplyComposer key={`${open.key}-${open.draft?.id ?? open.mode}`} detail={detail} initialMode={open.mode} draft={open.draft} onClose={() => setOpen(null)} />;
}

function ReplyComposer({
  detail,
  initialMode,
  draft,
  onClose,
}: {
  detail: ThreadDetail;
  initialMode: ReplyMode;
  draft: Draft | null;
  onClose(): void;
}) {
  const dir = useDirectory();
  const account = dir.accountById.get(detail.thread.accountId);
  const [initial] = useState<DraftFields>(() =>
    draft ? fieldsFromDraft(draft, splitDraftBody) : replyFields(initialMode, detail, account, dir.ownAddresses),
  );
  const editor = useDraftEditor(initial, { draftId: draft?.id ?? null });
  const { fields, update } = editor;
  const [editingRecipients, setEditingRecipients] = useState(fields.mode === "forward" || fields.to.length === 0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    if (fields.mode !== "forward" || fields.to.length > 0) {
      el.focus();
      el.setSelectionRange(0, 0);
    }
    surfaceRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing the conversation keeps what was typed.
  useEffect(() => () => void editor.flush(), [editor.flush]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchMode = (mode: ReplyMode) => {
    if (mode === fields.mode) return;
    const next = replyFields(mode, detail, account, dir.ownAddresses);
    update({ mode, to: next.to, cc: next.cc, subject: next.subject, quote: next.quote });
    setEditingRecipients(mode === "forward" || next.to.length === 0);
  };

  const send = async () => {
    if (invalidAddresses([...fields.to, ...fields.cc, ...fields.bcc]).length > 0) {
      setEditingRecipients(true);
      return;
    }
    if (await editor.send()) {
      editor.close();
      onClose();
    }
  };

  const discard = async () => {
    editor.close();
    await editor.discard();
    onClose();
  };

  const recipients = [...fields.to, ...fields.cc];
  const recipientSummary =
    recipients.length === 0
      ? "Add recipients"
      : recipients
          .slice(0, 3)
          .map((a) => (dir.ownAddresses.has(a.address.toLowerCase()) ? "me" : displayName(a)))
          .join(", ") + (recipients.length > 3 ? ` +${recipients.length - 3}` : "");

  return (
    <div
      ref={surfaceRef}
      className={cn(COMPOSER_SURFACE, "mt-1")}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void send();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void editor.flush();
          if (!hasContent(fields)) void discard();
          else onClose();
        }
      }}
    >
      <div className="px-3 pt-2">
        {editingRecipients ? (
          <div className="border-border/60 border-b pb-1">
            <RecipientField
              label="To"
              value={fields.to}
              onChange={(to) => update({ to })}
              autoFocus={fields.to.length === 0}
              placeholder="Name or address"
            />
            {fields.cc.length > 0 || fields.mode === "replyAll" ? (
              <RecipientField label="Cc" value={fields.cc} onChange={(cc) => update({ cc })} />
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setEditingRecipients(true)}
            title="Change recipients"
            className="flex h-7 max-w-full cursor-pointer items-center gap-1.5 truncate rounded-md px-1 -mx-1 text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
          >
            <span className="shrink-0">To:</span>
            <span className="truncate text-foreground/90">{recipientSummary}</span>
          </button>
        )}
      </div>
      <textarea
        ref={textRef}
        value={fields.text}
        onChange={(event) => update({ text: event.target.value })}
        placeholder={fields.mode === "forward" ? "Add a note" : "Write your reply"}
        aria-label="Message"
        dir={textDirection(fields.text) === "rtl" ? "rtl" : "auto"}
        rows={3}
        className="field-sizing-content block max-h-[min(22rem,50vh)] min-h-[5.5rem] w-full resize-none overflow-y-auto bg-transparent px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-placeholder"
      />
      <QuoteFold editor={editor} />
      <AttachmentChips editor={editor} className="px-3 pb-2" />
      <div className="flex items-center gap-1 px-1.5 pb-1.5">
        <QuietSelect
          ariaLabel="Reply, reply all or forward"
          items={MODES.map((m) => ({ value: m.value, label: m.label, icon: m.icon }))}
          value={fields.mode as ReplyMode}
          onChange={switchMode}
          side="top"
          label={
            <span className="flex items-center gap-1.5">
              {MODES.find((m) => m.value === fields.mode)?.icon}
              {MODES.find((m) => m.value === fields.mode)?.label}
            </span>
          }
        />
        {account ? (
          <span title={`Sent from ${account.email}`} className="flex min-w-0 items-center gap-1.5 px-1.5 text-muted-foreground text-xs">
            <AccountAvatar account={account} size={16} />
            <span className="truncate">{account.email}</span>
          </span>
        ) : null}
        <span className="ms-auto flex min-w-0 items-center gap-1">
          <SaveStatus editor={editor} />
          <AttachButton editor={editor} />
          <IconButton label="Discard draft" side="top" onClick={() => void discard()} className="rounded-full before:rounded-full">
            <Trash2Icon />
          </IconButton>
          <Button
            size="sm"
            className="rounded-full ps-3 pe-2.5 before:rounded-full"
            disabled={editor.sending || editor.uploading.length > 0}
            onClick={() => void send()}
            title="Send (Ctrl+Enter)"
          >
            {editor.sending ? <Spinner size="sm" /> : null}
            Send
            {editor.sending ? null : <SendHorizontalIcon className="size-3.5" />}
          </Button>
        </span>
      </div>
      <span className="sr-only">
        <Kbd>Ctrl Enter</Kbd> sends
      </span>
    </div>
  );
}
