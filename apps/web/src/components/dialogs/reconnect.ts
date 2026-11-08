import type { Account } from "@fancy-mail/contracts";

import { toast } from "~/components/ui/toast";
import { openExternal } from "~/lib/desktop";
import { errorMessage, rpc } from "~/rpc/client";
import { onOAuthFinished } from "~/state/events";
import { refreshBootstrap } from "~/state/actions";
import { useUi } from "~/state/ui";

/** Signs an account back in: a password form, or the provider's sign-in page for OAuth. */
export function startReconnect(account: Account) {
  if (account.authKind === "oauth-google" || account.authKind === "oauth-microsoft") {
    void reconnectOAuth(account);
    return;
  }
  useUi.getState().openDialog({ type: "reconnect", accountId: account.id });
}

async function reconnectOAuth(account: Account) {
  const provider = account.authKind === "oauth-google" ? "google" : "microsoft";
  try {
    const { flowId, authUrl } = await rpc("accounts.startOAuth", { provider, accountId: account.id });
    openExternal(authUrl);
    const toastId = toast.show({
      type: "loading",
      title: "Waiting for you to finish in the browser…",
      description: account.email,
      duration: 0,
      actions: [{ label: "Cancel", onClick: () => void rpc("accounts.cancelOAuth", { flowId }).catch(() => {}) }],
    });
    const off = onOAuthFinished((event) => {
      if (event.flowId !== flowId) return;
      off();
      toast.dismiss(toastId);
      refreshBootstrap();
      if (event.ok) toast.success("Signed in again", account.email);
      else if (event.error) toast.error("Sign-in didn't finish", event.error);
    });
  } catch (error) {
    toast.error("Couldn't start signing in", errorMessage(error));
  }
}
