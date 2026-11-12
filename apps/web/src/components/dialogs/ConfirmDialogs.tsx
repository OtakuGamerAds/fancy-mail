/** Confirmations (remove an account, delete a group or a label) and the password reconnect. */
import { useState } from "react";

import { AccountAvatar } from "~/components/common";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { toast } from "~/components/ui/toast";
import { errorMessage, rpc } from "~/rpc/client";
import { attempt, modifyThreads, refreshBootstrap } from "~/state/actions";
import { qk, queryClient, useDirectory } from "~/state/queries";
import { currentRoute, navigate } from "~/state/router";
import { useUi } from "~/state/ui";
import { plural } from "~/lib/utils";

export function ConfirmDialogs() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  const dir = useDirectory();
  const [busy, setBusy] = useState(false);

  const removeAccount = dialog?.type === "remove-account" ? dir.accountById.get(dialog.accountId) : undefined;
  const deleteGroup = dialog?.type === "delete-group" ? dir.groupById.get(dialog.groupId) : undefined;
  const deleteLabel = dialog?.type === "delete-label" ? dir.labelById.get(dialog.labelId) : undefined;
  const deleteForGood = dialog?.type === "delete-for-good" ? dialog.threadIds : null;

  const run = async (work: () => Promise<unknown>, failure: string, after?: () => void) => {
    setBusy(true);
    const ok = await attempt(async () => {
      await work();
      return true;
    }, failure);
    setBusy(false);
    if (ok) {
      close();
      refreshBootstrap();
      void queryClient.invalidateQueries({ queryKey: qk.threadsAll });
      after?.();
    }
  };

  const leaveIfShowing = (match: (key: string) => boolean) => {
    const route = currentRoute();
    if (route.page !== "mail") return;
    if (match(JSON.stringify(route.view))) navigate({ page: "mail", view: { kind: "inbox", scope: { type: "all" } }, threadId: null }, { replace: true });
  };

  const groupAccounts = deleteGroup ? dir.accounts.filter((a) => a.groupId === deleteGroup.id).length : 0;

  return (
    <>
      <AlertDialog open={!!removeAccount} onOpenChange={(open) => !open && !busy && close()}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeAccount?.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Fancy Mail forgets this account, its password and the mail it downloaded. Nothing on the mail server is deleted: your mail stays there, and you can add the account again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                removeAccount &&
                void run(
                  () => rpc("accounts.remove", { accountId: removeAccount.id }),
                  "Couldn't remove the account",
                  () => leaveIfShowing((key) => key.includes(removeAccount.id)),
                )
              }
            >
              {busy ? <Spinner size="sm" /> : null}
              Remove account
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={!!deleteGroup} onOpenChange={(open) => !open && !busy && close()}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the group “{deleteGroup?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {groupAccounts > 0
                ? `Its ${plural(groupAccounts, "account")} stay and move to Ungrouped. No mail is touched.`
                : "It has no accounts. No mail is touched."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                deleteGroup &&
                void run(
                  () => rpc("groups.delete", { groupId: deleteGroup.id }),
                  "Couldn't delete the group",
                  () => leaveIfShowing((key) => key.includes(deleteGroup.id)),
                )
              }
            >
              Delete group
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={!!deleteForGood} onOpenChange={(open) => !open && !busy && close()}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteForGood && deleteForGood.length > 1 ? plural(deleteForGood.length, "conversation") : "this conversation"} for good?</AlertDialogTitle>
            <AlertDialogDescription>
              Fancy Mail's Trash keeps mail. This moves it to the mail server's own trash instead, which empties itself (Gmail after 30
              days); after that it's gone. Until then, Restore still brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                deleteForGood &&
                void run(() => modifyThreads(deleteForGood, [{ type: "deleteForGood" }]), "Couldn't delete it", () => useUi.getState().clearSelection())
              }
            >
              Delete for good
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={!!deleteLabel} onOpenChange={(open) => !open && !busy && close()}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the label “{deleteLabel?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteLabel && deleteLabel.threadCount > 0
                ? `It comes off ${plural(deleteLabel.threadCount, "conversation")}, here and on the mail servers. The mail itself stays.`
                : "No conversation has it. The mail itself is not touched."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                deleteLabel &&
                void run(
                  () => rpc("labels.delete", { labelId: deleteLabel.id }),
                  "Couldn't delete the label",
                  () => leaveIfShowing((key) => key.includes(deleteLabel.id)),
                )
              }
            >
              Delete label
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <ReconnectDialog />
    </>
  );
}

function ReconnectDialog() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  const dir = useDirectory();
  const account = dialog?.type === "reconnect" ? dir.accountById.get(dialog.accountId) : undefined;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!account || !password) return;
    setBusy(true);
    setError(null);
    try {
      await rpc("accounts.reconnect", { accountId: account.id, password });
      setPassword("");
      close();
      refreshBootstrap();
      toast.success("Signed in again", account.email);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!account}
      onOpenChange={(open) => {
        if (!open && !busy) {
          close();
          setPassword("");
          setError(null);
        }
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reconnect</DialogTitle>
          <DialogDescription>
            The server stopped accepting the saved password. Your downloaded mail stays readable; enter the password again to keep syncing.
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogPanel className="space-y-3">
            {account ? (
              <div className="flex items-center gap-2.5 rounded-lg border bg-muted/50 px-3 py-2">
                <AccountAvatar account={account} size={24} />
                <div className="min-w-0">
                  <div className="truncate font-medium text-sm">{account.displayName || account.email}</div>
                  <div className="truncate text-muted-foreground text-xs">{account.email}</div>
                </div>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="reconnect-password">{account?.provider === "gmail" ? "App password" : "Password"}</Label>
              <Input
                id="reconnect-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                aria-invalid={error ? true : undefined}
              />
              {error ? <p className="text-destructive-foreground text-xs">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close()} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Spinner size="sm" /> : null}
              {busy ? "Checking sign-in…" : "Reconnect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
