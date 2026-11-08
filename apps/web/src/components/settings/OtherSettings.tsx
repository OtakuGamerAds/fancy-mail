/** Settings › Reading, Sign in with Google / Microsoft, Data, About. */
import { ExternalLinkIcon, FolderOpenIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { FieldSelect } from "~/components/selects";
import { useUpdateState } from "~/components/sidebar/UpdateButton";
import { removeDemoMail } from "~/components/list/DemoBanner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { toast } from "~/components/ui/toast";
import { bridge, describeUpdate, isDesktop, openExternal } from "~/lib/desktop";
import { errorMessage, rpc } from "~/rpc/client";
import { refreshBootstrap, updateSettings } from "~/state/actions";
import { qk, queryClient, useBootstrap } from "~/state/queries";
import { copyText } from "./AgentsSettings";
import { SettingsRow, SettingsSection } from "./layout";

const REPO_URL = "https://github.com/OtakuGamerAds/fancy-mail";

// ── Reading ─────────────────────────────────────────────────────────────────────────────────

export function ReadingSettings() {
  const { data: bootstrap } = useBootstrap();
  if (!bootstrap) return null;
  const { settings } = bootstrap;
  return (
    <>
      <SettingsSection title="Reading">
        <SettingsRow
          title="Reading pane"
          description="Right: the conversation opens beside the list. Off: it opens in place of the list."
          control={
            <FieldSelect
              items={[
                { value: "right", label: "On the right" },
                { value: "off", label: "Off" },
              ]}
              value={settings.readingPane}
              onChange={(readingPane) => void updateSettings({ readingPane })}
              ariaLabel="Reading pane"
              size="sm"
            />
          }
        />
        <SettingsRow
          title="Density"
          description="Comfortable shows a preview line under each conversation."
          control={
            <FieldSelect
              items={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
              value={settings.density}
              onChange={(density) => void updateSettings({ density })}
              ariaLabel="Density"
              size="sm"
            />
          }
        />
        <SettingsRow
          title="Remote images"
          description="Images from the web can tell the sender you opened their mail. Ask: they stay hidden until you show them."
          control={
            <FieldSelect
              items={[
                { value: "ask", label: "Ask first" },
                { value: "always", label: "Always show" },
              ]}
              value={settings.remoteImages}
              onChange={(remoteImages) => void updateSettings({ remoteImages })}
              ariaLabel="Remote images"
              size="sm"
            />
          }
        />
        {isDesktop() ? (
          <SettingsRow
            title="Keep running in the tray"
            description="Closing the window keeps Fancy Mail syncing in the background."
            control={
              <Switch
                checked={settings.closeToTray}
                onCheckedChange={(closeToTray) => {
                  void updateSettings({ closeToTray });
                  bridge()?.setCloseToTray(closeToTray);
                }}
                aria-label="Keep running in the tray"
              />
            }
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Senders whose images always show" description="Added with “Always for …” above a message.">
        {settings.allowedImageSenders.length === 0 ? (
          <div className="px-4 py-4 text-muted-foreground text-sm">None yet.</div>
        ) : (
          settings.allowedImageSenders.map((sender) => (
            <div key={sender} className="flex h-11 items-center gap-2 px-4">
              <span className="min-w-0 flex-1 truncate text-sm" data-selectable>
                {sender}
              </span>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => void updateSettings({ allowedImageSenders: settings.allowedImageSenders.filter((s) => s !== sender) })}
              >
                <XIcon />
                Remove
              </Button>
            </div>
          ))
        )}
      </SettingsSection>
    </>
  );
}

// ── Sign in with Google / Microsoft ─────────────────────────────────────────────────────────

export function SignInSettings() {
  const { data: bootstrap } = useBootstrap();
  const oauth = bootstrap?.settings.oauth;
  const [googleId, setGoogleId] = useState(oauth?.googleClientId ?? "");
  const [googleSecret, setGoogleSecret] = useState(oauth?.googleClientSecret ?? "");
  const [microsoftId, setMicrosoftId] = useState(oauth?.microsoftClientId ?? "");
  useEffect(() => {
    if (!oauth) return;
    setGoogleId(oauth.googleClientId);
    setGoogleSecret(oauth.googleClientSecret);
    setMicrosoftId(oauth.microsoftClientId);
  }, [oauth]);
  if (!bootstrap || !oauth) return null;
  const save = (patch: Partial<typeof oauth>) => void updateSettings({ oauth: { ...oauth, ...patch } });
  const changed =
    googleId.trim() !== oauth.googleClientId || googleSecret.trim() !== oauth.googleClientSecret || microsoftId.trim() !== oauth.microsoftClientId;

  return (
    <>
      <div className="space-y-2 px-3 sm:px-4">
        <h2 className="font-semibold text-base">Sign in with Google or Microsoft</h2>
        <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
          Signing in through the browser needs your own client ID, made once. App passwords (Gmail, Yahoo, iCloud) need none of this.
        </p>
      </div>
      <SettingsSection title="Google">
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <ol className="list-decimal space-y-1.5 ps-5 text-muted-foreground text-sm leading-relaxed marker:text-muted-foreground/60">
            <li>
              Open the{" "}
              <button type="button" className="cursor-pointer text-foreground underline underline-offset-2" onClick={() => openExternal("https://console.cloud.google.com/")}>
                Google Cloud console
              </button>{" "}
              and make a new project.
            </li>
            <li>Under APIs & Services, enable the Gmail API.</li>
            <li>
              Set up the OAuth consent screen as <span className="text-foreground">External</span>, then publish it{" "}
              <span className="text-foreground">In production</span> (in Testing, Google signs you out every 7 days).
            </li>
            <li>
              Under Credentials, create an OAuth client ID of type <span className="text-foreground">Desktop app</span>.
            </li>
            <li>Paste its client ID and secret here.</li>
          </ol>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={googleId} onChange={(e) => setGoogleId(e.target.value)} placeholder="Client ID" aria-label="Google client ID" spellCheck={false} />
            <Input value={googleSecret} onChange={(e) => setGoogleSecret(e.target.value)} placeholder="Client secret" type="password" aria-label="Google client secret" />
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Microsoft">
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <ol className="list-decimal space-y-1.5 ps-5 text-muted-foreground text-sm leading-relaxed marker:text-muted-foreground/60">
            <li>
              In the{" "}
              <button
                type="button"
                className="cursor-pointer text-foreground underline underline-offset-2"
                onClick={() => openExternal("https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade")}
              >
                Microsoft Entra admin center
              </button>
              , register a new app for personal and work accounts.
            </li>
            <li>
              Add the platform <span className="text-foreground">Mobile and desktop applications</span> with the redirect URI <code className="text-foreground">http://localhost</code>.
            </li>
            <li>Paste its Application (client) ID here.</li>
          </ol>
          <Input value={microsoftId} onChange={(e) => setMicrosoftId(e.target.value)} placeholder="Application (client) ID" aria-label="Microsoft client ID" spellCheck={false} />
        </div>
      </SettingsSection>
      <div className="flex justify-end gap-2 px-3 sm:px-4">
        <Button
          variant="ghost"
          size="sm"
          disabled={!changed}
          onClick={() => {
            setGoogleId(oauth.googleClientId);
            setGoogleSecret(oauth.googleClientSecret);
            setMicrosoftId(oauth.microsoftClientId);
          }}
        >
          Reset
        </Button>
        <Button
          size="sm"
          disabled={!changed}
          onClick={() => {
            save({ googleClientId: googleId.trim(), googleClientSecret: googleSecret.trim(), microsoftClientId: microsoftId.trim() });
            toast.show({ title: "Saved", duration: 2000 });
          }}
        >
          Save
        </Button>
      </div>
    </>
  );
}

// ── Data ────────────────────────────────────────────────────────────────────────────────────

export function DataSettings() {
  const { data: bootstrap } = useBootstrap();
  const [busy, setBusy] = useState<"remove" | "reset" | null>(null);
  if (!bootstrap) return null;
  const desktop = bridge();

  const resetDemo = async () => {
    setBusy("reset");
    try {
      await rpc("demo.reset", {});
      refreshBootstrap();
      void queryClient.invalidateQueries({ queryKey: qk.threadsAll });
      toast.show({ title: "Demo mail is back as it was", duration: 3000 });
    } catch (error) {
      toast.error("Couldn't reset the demo mail", errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SettingsSection title="Data" description="All mail lives on this computer, in one SQLite file in this folder.">
        <SettingsRow
          title="Data folder"
          status={
            <code className="break-all font-mono text-[12px] text-foreground/85" data-selectable>
              {bootstrap.dataDir}
            </code>
          }
          control={
            desktop ? (
              <Button size="sm" variant="outline" onClick={() => desktop.openPath(bootstrap.dataDir)}>
                <FolderOpenIcon />
                Open folder
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => copyText(bootstrap.dataDir, "Path copied")}>
                Copy path
              </Button>
            )
          }
        />
      </SettingsSection>
      <SettingsSection title="Demo mail" description="Made-up accounts and mail to look around with. Removing it doesn't touch your own accounts.">
        <SettingsRow
          title={bootstrap.hasDemoData ? "Demo mail is shown" : "Demo mail is removed"}
          control={
            <span className="flex items-center gap-2">
              {bootstrap.hasDemoData ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy("remove");
                    await removeDemoMail();
                    setBusy(null);
                  }}
                >
                  {busy === "remove" ? <Spinner size="sm" /> : null}
                  Remove
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void resetDemo()}>
                {busy === "reset" ? <Spinner size="sm" /> : null}
                {bootstrap.hasDemoData ? "Reset" : "Bring back"}
              </Button>
            </span>
          }
        />
      </SettingsSection>
    </>
  );
}

// ── About ───────────────────────────────────────────────────────────────────────────────────

export function AboutSettings() {
  const { data: bootstrap } = useBootstrap();
  const update = useUpdateState();
  const info = describeUpdate(update);
  const desktop = bridge();
  return (
    <SettingsSection title="About">
      <SettingsRow
        title="Fancy Mail"
        description="A calm, fast email client for many accounts, with an MCP server so your agents can organize mail from the outside."
        status={`Version ${desktop?.version ?? bootstrap?.version ?? "—"}`}
      />
      {desktop?.update ? (
        <SettingsRow
          title="Updates"
          status={
            update?.status === "checking"
              ? "Checking…"
              : info.phase === "available"
                ? `Version ${info.version ?? ""} is available.`
                : info.phase === "downloading"
                  ? `Downloading${info.percent !== null ? ` (${Math.floor(info.percent)}%)` : ""}…`
                  : info.phase === "ready"
                    ? `Version ${info.version ?? ""} is ready. Restart to install it.`
                    : update?.status === "error"
                      ? (update.message ?? "Couldn't check for updates.")
                      : update?.status === "disabled" || update?.enabled === false
                        ? "Updates arrive with the installed app."
                        : "You're up to date."
          }
          control={
            info.phase === "available" ? (
              <Button size="sm" onClick={() => void desktop.update?.download()}>
                Download
              </Button>
            ) : info.phase === "ready" ? (
              <Button size="sm" onClick={() => void desktop.update?.install()}>
                Restart and install
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={update?.status === "checking" || info.phase === "downloading"} onClick={() => void desktop.update?.check()}>
                Check for updates
              </Button>
            )
          }
        />
      ) : null}
      <SettingsRow
        title="Source code"
        description="MIT licensed. The look follows T3 Code."
        control={
          <Button size="sm" variant="outline" onClick={() => openExternal(REPO_URL)}>
            <ExternalLinkIcon />
            GitHub
          </Button>
        }
      />
    </SettingsSection>
  );
}
