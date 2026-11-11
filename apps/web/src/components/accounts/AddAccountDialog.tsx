/**
 * Add account: 1) address and name → the provider is detected; 2) sign in with an app
 * password (servers filled in, editable) or with Google / Microsoft in the browser; 3) pick a
 * group. Nothing is saved until the sign-in works.
 */
import type { Account, ProviderDetection, ServerEndpoint } from "@fancy-mail/contracts";
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, ExternalLinkIcon, FolderPlusIcon, KeyRoundIcon, LogInIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AccountAvatar, ColorDot } from "~/components/common";
import { FieldSelect } from "~/components/selects";
import { Button, InlineButton } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { toast } from "~/components/ui/toast";
import { isValidEmail } from "~/lib/addresses";
import { openExternal } from "~/lib/desktop";
import { cn } from "~/lib/utils";
import { errorMessage, rpc } from "~/rpc/client";
import { createGroup, refreshBootstrap, updateAccount } from "~/state/actions";
import { onOAuthFinished } from "~/state/events";
import { qk, queryClient, useDirectory } from "~/state/queries";
import { navigate } from "~/state/router";
import { useUi } from "~/state/ui";

type AuthOption = ProviderDetection["auth"][number];

type Step =
  | { kind: "address" }
  | { kind: "auth"; detection: ProviderDetection; method: AuthOption }
  | { kind: "waiting"; detection: ProviderDetection; flowId: string }
  | { kind: "group"; account: Account };

export function AddAccountDialog() {
  const dialog = useUi((s) => s.dialog);
  const close = useUi((s) => s.closeDialog);
  const open = dialog?.type === "add-account";
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (open) setSession((s) => s + 1);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogPopup className="max-w-[480px]">
        {open ? <AddAccountFlow key={session} initialGroupId={dialog?.type === "add-account" ? dialog.groupId ?? null : null} onClose={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function methodLabel(method: AuthOption): string {
  if (method === "password") return "App password";
  if (method === "oauth-google") return "Sign in with Google";
  return "Sign in with Microsoft";
}

function AddAccountFlow({ initialGroupId, onClose }: { initialGroupId: string | null; onClose(): void }) {
  const [step, setStep] = useState<Step>({ kind: "address" });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = (account: Account) => {
    refreshBootstrap();
    void queryClient.invalidateQueries({ queryKey: qk.threadsAll });
    setStep({ kind: "group", account });
  };

  // ── 1. Address ──
  if (step.kind === "address") {
    const submit = async () => {
      if (!isValidEmail(email)) {
        setError("That doesn't look like an email address.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const detection = await rpc("accounts.detect", { email: email.trim() });
        setStep({ kind: "auth", detection, method: detection.auth[0] ?? "password" });
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>Gmail, Outlook, Yahoo, iCloud, GMX, WEB.DE, or any IMAP mailbox.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Field label="Email address" htmlFor="add-email">
            <Input
              id="add-email"
              type="email"
              autoFocus
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </Field>
          <Field label="Your name" hint="Shown to the people you write to." htmlFor="add-name">
            <Input id="add-name" autoComplete="name" placeholder="Anna Weber" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !email.trim()}>
            {busy ? <Spinner size="sm" /> : null}
            Continue
          </Button>
        </DialogFooter>
      </form>
    );
  }

  // ── 2b. Waiting for the browser ──
  if (step.kind === "waiting") {
    return (
      <OAuthWaiting
        flowId={step.flowId}
        email={email}
        onBack={() => setStep({ kind: "auth", detection: step.detection, method: step.detection.auth.find((a) => a !== "password") ?? "password" })}
        onDone={async (accountId) => {
          if (!accountId) return;
          const bootstrap = await queryClient.fetchQuery({ queryKey: qk.bootstrap, queryFn: () => rpc("app.bootstrap", {}), staleTime: 0 });
          const account = bootstrap.accounts.find((a) => a.id === accountId);
          if (account) finish(account);
          else onClose();
        }}
      />
    );
  }

  // ── 3. Group ──
  if (step.kind === "group") {
    return <PickGroup account={step.account} initialGroupId={initialGroupId} onDone={onClose} />;
  }

  // ── 2. Sign in ──
  return (
    <SignIn
      detection={step.detection}
      method={step.method}
      email={email.trim()}
      name={name.trim()}
      groupId={initialGroupId}
      onMethod={(method) => setStep({ ...step, method })}
      onBack={() => setStep({ kind: "address" })}
      onWaiting={(flowId) => setStep({ kind: "waiting", detection: step.detection, flowId })}
      onAdded={finish}
      onClose={onClose}
    />
  );
}

function Field({ label, hint, htmlFor, children, className }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

function SignIn({
  detection,
  method,
  email,
  name,
  groupId,
  onMethod,
  onBack,
  onWaiting,
  onAdded,
  onClose,
}: {
  detection: ProviderDetection;
  method: AuthOption;
  email: string;
  name: string;
  groupId: string | null;
  onMethod(method: AuthOption): void;
  onBack(): void;
  onWaiting(flowId: string): void;
  onAdded(account: Account): void;
  onClose(): void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const custom = detection.imap === null || detection.smtp === null;
  const [showServers, setShowServers] = useState(custom);
  const domain = email.split("@")[1] ?? "";
  const [imap, setImap] = useState<ServerEndpoint>(detection.imap ?? { host: `imap.${domain}`, port: 993, secure: true });
  const [smtp, setSmtp] = useState<ServerEndpoint>(detection.smtp ?? { host: `smtp.${domain}`, port: 465, secure: true });
  const [username, setUsername] = useState("");

  const addWithPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await rpc("accounts.addWithPassword", {
        email,
        displayName: name || email.split("@")[0]!,
        password,
        provider: detection.provider === "demo" ? "imap" : detection.provider,
        imap,
        smtp,
        ...(username.trim() ? { username: username.trim() } : {}),
        groupId,
      });
      onAdded(account);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const { flowId, authUrl } = await rpc("accounts.startOAuth", { provider: method === "oauth-google" ? "google" : "microsoft", groupId });
      openExternal(authUrl);
      onWaiting(flowId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (method === "password") void addWithPassword();
        else void startOAuth();
      }}
    >
      <DialogHeader>
        <DialogTitle>{detection.name !== "IMAP" && detection.name ? `Sign in to ${detection.name}` : "Sign in"}</DialogTitle>
        <DialogDescription className="truncate">{email}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {detection.auth.length > 1 ? (
          <div role="radiogroup" aria-label="How to sign in" className="grid gap-2">
            {detection.auth.map((option, index) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={method === option}
                onClick={() => onMethod(option)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  method === option ? "border-primary/60 bg-primary/8" : "border-input hover:bg-accent",
                )}
              >
                {option === "password" ? <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" /> : <LogInIcon className="size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-sm">
                    {methodLabel(option)}
                    {index === 0 ? <span className="ms-2 font-normal text-muted-foreground text-xs">Recommended</span> : null}
                  </span>
                  <span className="block text-muted-foreground text-xs">
                    {option === "password" ? "Works over IMAP; never expires on its own." : "Opens your browser to sign in."}
                  </span>
                </span>
                <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border", method === option ? "border-primary bg-primary" : "border-input")}>
                  {method === option ? <span className="size-1.5 rounded-full bg-white" /> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {method === "password" ? (
          <>
            {detection.passwordHint ? <p className="text-muted-foreground text-sm">{detection.passwordHint}</p> : null}
            {detection.appPasswordUrl ? (
              <Button variant="outline" size="sm" onClick={() => openExternal(detection.appPasswordUrl!)}>
                <ExternalLinkIcon />
                Create an app password
              </Button>
            ) : null}
            <Field label={detection.appPasswordUrl ? "App password" : "Password"} htmlFor="add-password">
              <Input
                id="add-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
              />
            </Field>
            <div>
              <button
                type="button"
                aria-expanded={showServers}
                onClick={() => setShowServers((s) => !s)}
                className="flex cursor-pointer items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
              >
                <ChevronRightIcon className={cn("size-4 transition-transform", showServers && "rotate-90")} />
                Server settings
              </button>
              {showServers ? (
                <div className="mt-3 space-y-3 rounded-xl border border-border p-3">
                  <ServerFields label="Incoming (IMAP)" value={imap} onChange={setImap} />
                  <ServerFields label="Outgoing (SMTP)" value={smtp} onChange={setSmtp} />
                  <Field label="Username" hint="Leave empty to use the email address." htmlFor="add-username">
                    <Input id="add-username" value={username} placeholder={email} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
                  </Field>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            Your browser opens {method === "oauth-google" ? "Google's" : "Microsoft's"} sign-in page. Fancy Mail never sees your password. If it says the app isn't set up yet, add a client ID in{" "}
            <InlineButton
              tone="default"
              onClick={() => {
                onClose();
                navigate({ page: "settings", section: "sign-in" });
              }}
            >
              Settings › Sign in
            </InlineButton>
            .
          </p>
        )}
        {error ? (
          <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-destructive-foreground text-sm">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onBack} disabled={busy} className="sm:me-auto">
          <ArrowLeftIcon />
          Back
        </Button>
        <Button type="submit" disabled={busy || (method === "password" && !password)}>
          {busy ? <Spinner size="sm" /> : null}
          {method === "password" ? (busy ? "Checking sign-in…" : "Add account") : "Continue in browser"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ServerFields({ label, value, onChange }: { label: string; value: ServerEndpoint; onChange(next: ServerEndpoint): void }) {
  return (
    <div className="space-y-1.5">
      <div className="font-medium text-sm">{label}</div>
      <div className="grid grid-cols-[1fr_5.5rem] gap-2">
        <Input aria-label={`${label} host`} value={value.host} onChange={(event) => onChange({ ...value, host: event.target.value.trim() })} />
        <Input
          aria-label={`${label} port`}
          inputMode="numeric"
          value={String(value.port)}
          onChange={(event) => {
            const port = Number(event.target.value.replace(/\D/g, ""));
            if (port > 0 && port < 65536) onChange({ ...value, port });
          }}
        />
      </div>
      <FieldSelect
        ariaLabel={`${label} security`}
        size="sm"
        items={[
          { value: "tls", label: "SSL/TLS", description: "Encrypted from the start (993, 465)" },
          { value: "starttls", label: "STARTTLS", description: "Upgrades to encryption (143, 587)" },
        ]}
        value={value.secure ? "tls" : "starttls"}
        onChange={(v) => onChange({ ...value, secure: v === "tls" })}
      />
    </div>
  );
}

function OAuthWaiting({ flowId, email, onBack, onDone }: { flowId: string; email: string; onBack(): void; onDone(accountId: string | null): void }) {
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(
    () =>
      onOAuthFinished((event) => {
        if (event.flowId !== flowId) return;
        if (event.ok) doneRef.current(event.accountId);
        else setError(event.error ?? "The sign-in didn't finish.");
      }),
    [flowId],
  );
  const cancel = () => {
    void rpc("accounts.cancelOAuth", { flowId }).catch(() => {});
    onBack();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Finish in your browser</DialogTitle>
        <DialogDescription className="truncate">{email}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {error ? (
          <p role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-destructive-foreground text-sm">
            {error}
          </p>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-4 text-muted-foreground text-sm">
            <Spinner size="md" tone="muted" />
            Waiting for you to finish in the browser…
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={cancel}>
          {error ? "Back" : "Cancel"}
        </Button>
      </DialogFooter>
    </>
  );
}

function PickGroup({ account, initialGroupId, onDone }: { account: Account; initialGroupId: string | null; onDone(): void }) {
  const dir = useDirectory();
  const [choice, setChoice] = useState<string>(initialGroupId ?? account.groupId ?? "__none");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const done = async () => {
    setBusy(true);
    let groupId: string | null = choice === "__none" ? null : choice;
    if (choice === "__new") {
      const group = newName.trim() ? await createGroup(newName.trim()) : undefined;
      groupId = group?.id ?? null;
    }
    if (groupId !== account.groupId) await updateAccount(account.id, { groupId });
    setBusy(false);
    toast.success("Account added", `${account.email} is syncing now.`);
    onDone();
    navigate({ page: "mail", view: { kind: "inbox", scope: { type: "account", accountId: account.id } }, threadId: null });
  };

  const options: { id: string; label: string; color: string | null }[] = [
    ...dir.groups.map((g) => ({ id: g.id, label: g.name, color: g.color })),
    { id: "__none", label: "No group", color: null },
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-full bg-success/16 text-success-foreground">
            <CheckIcon className="size-3.5" />
          </span>
          Added
        </DialogTitle>
        <DialogDescription>Which group does it belong to? Every group has its own inbox.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-3">
        <div className="flex items-center gap-2.5 rounded-xl border bg-muted/50 px-3 py-2">
          <AccountAvatar account={account} size={24} />
          <div className="min-w-0">
            <div className="truncate font-medium text-sm">{account.displayName || account.email}</div>
            <div className="truncate text-muted-foreground text-xs">{account.email}</div>
          </div>
        </div>
        <div role="radiogroup" aria-label="Group" className="grid max-h-64 gap-1 overflow-y-auto">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={choice === option.id}
              onClick={() => setChoice(option.id)}
              className={cn(
                "flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                choice === option.id ? "bg-white/[0.08] text-foreground" : "text-foreground/85 hover:bg-accent",
              )}
            >
              <ColorDot color={option.color} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {choice === option.id ? <CheckIcon className="size-4" /> : null}
            </button>
          ))}
          <div
            className={cn("flex h-9 items-center gap-2.5 rounded-lg px-3", choice === "__new" ? "bg-white/[0.08]" : "hover:bg-accent")}
            onClick={() => setChoice("__new")}
          >
            <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
                setChoice("__new");
              }}
              onFocus={() => setChoice("__new")}
              placeholder="New group…"
              aria-label="New group name"
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
            />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button onClick={() => void done()} disabled={busy || (choice === "__new" && !newName.trim())}>
          {busy ? <Spinner size="sm" /> : null}
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
