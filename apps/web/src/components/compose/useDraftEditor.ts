/**
 * The state behind both composers (the reply under a conversation and the New message
 * dialog): fields, autosave 800 ms after typing stops (only once something was typed), send,
 * discard, and attachments uploaded through POST /api/uploads.
 */
import type { Address, Draft, DraftAttachment, DraftMode } from "@fancy-mail/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "~/components/ui/toast";
import { errorMessage, rpc } from "~/rpc/client";
import { qk, queryClient } from "~/state/queries";

export interface DraftFields {
  accountId: string;
  mode: DraftMode;
  threadId: string | null;
  sourceMessageId: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** What the person writes. */
  text: string;
  /** The quoted or forwarded original, kept below the text. */
  quote: string | null;
  attachments: DraftAttachment[];
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface UploadingFile {
  key: string;
  name: string;
}

function bodyOf(fields: DraftFields): string {
  return fields.quote ? `${fields.text.replace(/\s+$/, "")}\n\n${fields.quote}` : fields.text;
}

export function hasContent(fields: DraftFields): boolean {
  if (fields.text.trim().length > 0 || fields.attachments.length > 0) return true;
  if (fields.mode !== "new") return false;
  return fields.subject.trim().length > 0 || fields.to.length + fields.cc.length + fields.bcc.length > 0;
}

export async function uploadFile(file: File): Promise<DraftAttachment> {
  const response = await fetch("/api/uploads", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "x-filename": encodeURIComponent(file.name),
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!response.ok) {
    let message = `The upload failed (${response.status}).`;
    try {
      const body = (await response.json()) as { message?: string; error?: { message?: string } };
      message = body.error?.message ?? body.message ?? message;
    } catch {
      // Not JSON: keep the status line.
    }
    throw new Error(message);
  }
  const body = (await response.json()) as DraftAttachment | { attachment: DraftAttachment };
  return "attachment" in body ? body.attachment : body;
}

export function useDraftEditor(initial: DraftFields, options: { draftId?: string | null }) {
  const [fields, setFields] = useState<DraftFields>(initial);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [sending, setSending] = useState(false);
  const fieldsRef = useRef(fields);
  const idRef = useRef<string | null>(options.draftId ?? null);
  const dirtyRef = useRef(false);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);

  fieldsRef.current = fields;

  const save = useCallback((): Promise<Draft | undefined> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const run = async (): Promise<Draft | undefined> => {
      if (!dirtyRef.current && idRef.current) return undefined;
      const current = fieldsRef.current;
      dirtyRef.current = false;
      setSaveState("saving");
      try {
        const draft = await rpc("drafts.save", {
          draft: {
            ...(idRef.current ? { id: idRef.current } : {}),
            accountId: current.accountId,
            mode: current.mode,
            threadId: current.threadId,
            sourceMessageId: current.sourceMessageId,
            to: current.to,
            cc: current.cc,
            bcc: current.bcc,
            subject: current.subject,
            bodyText: bodyOf(current),
            attachments: current.attachments,
          },
        });
        idRef.current = draft.id;
        setSaveState("saved");
        return draft;
      } catch (error) {
        dirtyRef.current = true;
        setSaveState("error");
        throw error;
      }
    };
    const next = chainRef.current.then(run, run);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (closedRef.current) return;
      save().catch(() => {});
    }, 800);
  }, [save]);

  const update = useCallback(
    (patch: Partial<DraftFields>) => {
      setFields((prev) => {
        const next = { ...prev, ...patch };
        fieldsRef.current = next;
        return next;
      });
      dirtyRef.current = true;
      if (hasContent({ ...fieldsRef.current, ...patch })) scheduleSave();
    },
    [scheduleSave],
  );

  /** Save now if anything changed (closing keeps the draft). */
  const flush = useCallback(async () => {
    if (closedRef.current) return;
    if (timerRef.current || (dirtyRef.current && hasContent(fieldsRef.current))) {
      try {
        await save();
        void queryClient.invalidateQueries({ queryKey: qk.drafts });
      } catch (error) {
        toast.error("Couldn't save the draft", errorMessage(error));
      }
    }
  }, [save]);

  const send = useCallback(async (): Promise<boolean> => {
    const current = fieldsRef.current;
    if (current.to.length + current.cc.length + current.bcc.length === 0) {
      toast.error("Add someone to send it to");
      return false;
    }
    setSending(true);
    try {
      dirtyRef.current = true;
      await save();
      const draftId = idRef.current;
      if (!draftId) throw new Error("The draft could not be saved.");
      closedRef.current = true;
      await rpc("drafts.send", { draftId });
      toast.show({ id: `send-${draftId}`, type: "loading", title: "Sending…", duration: 0 });
      void queryClient.invalidateQueries({ queryKey: qk.drafts });
      if (current.threadId) void queryClient.invalidateQueries({ queryKey: qk.thread(current.threadId) });
      return true;
    } catch (error) {
      closedRef.current = false;
      toast.error("Couldn't send your message", errorMessage(error));
      return false;
    } finally {
      setSending(false);
    }
  }, [save]);

  const discard = useCallback(async () => {
    closedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    await chainRef.current;
    const id = idRef.current;
    if (!id) return;
    try {
      await rpc("drafts.delete", { draftId: id });
      idRef.current = null;
      void queryClient.invalidateQueries({ queryKey: qk.drafts });
      const threadId = fieldsRef.current.threadId;
      if (threadId) void queryClient.invalidateQueries({ queryKey: qk.thread(threadId) });
    } catch (error) {
      toast.error("Couldn't discard the draft", errorMessage(error));
    }
  }, []);

  const attach = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const key = `${file.name}-${file.size}-${Math.random()}`;
        setUploading((u) => [...u, { key, name: file.name }]);
        try {
          const attachment = await uploadFile(file);
          update({ attachments: [...fieldsRef.current.attachments, attachment] });
        } catch (error) {
          toast.error(`Couldn't attach ${file.name}`, errorMessage(error));
        } finally {
          setUploading((u) => u.filter((x) => x.key !== key));
        }
      }
    },
    [update],
  );

  // Leaving the page with unsaved typing: save it.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flush]);

  return {
    fields,
    update,
    save,
    flush,
    send,
    discard,
    attach,
    uploading,
    sending,
    saveState,
    draftId: () => idRef.current,
    /** Stop autosaving (after send or discard, before unmount). */
    close: () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
  };
}

export type DraftEditor = ReturnType<typeof useDraftEditor>;

/** Draft → editor fields (splitting the quoted original back off). */
export function fieldsFromDraft(draft: Draft, split: (body: string) => { text: string; quote: string | null }): DraftFields {
  const { text, quote } = split(draft.bodyText);
  return {
    accountId: draft.accountId,
    mode: draft.mode,
    threadId: draft.threadId,
    sourceMessageId: draft.sourceMessageId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text,
    quote,
    attachments: draft.attachments,
  };
}
