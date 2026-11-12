/**
 * Settings › Agents. Fancy Mail has no AI inside; agents the person already uses connect over
 * MCP. Here: the switch, one line to copy into an agent (it points to the agent folder, where
 * the agent reads how to connect: see server mcp/guide.ts), the address and token under
 * Advanced, how much each account lets agents do, and who is connected.
 */
import { AGENT_ACCESS_INFO, type AgentAccess } from "@fancy-mail/contracts";
import { CheckIcon, ChevronRightIcon, CopyIcon, EyeIcon, EyeOffIcon, HistoryIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { AccountAvatar, ColorDot, IconButton } from "~/components/common";
import { FieldSelect } from "~/components/selects";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button, InlineButton } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { toast } from "~/components/ui/toast";
import { prettifyAgentName } from "~/lib/agents";
import { formatRelative } from "~/lib/format";
import { errorMessage, rpc } from "~/rpc/client";
import { updateAccount, updateSettings } from "~/state/actions";
import { qk, queryClient, useBootstrap, useDirectory } from "~/state/queries";
import { navigate } from "~/state/router";
import { ACCESS_CHOICES } from "./AccountsSettings";
import { CodeBlock, SettingsRow, SettingsSection } from "./layout";

export function copyText(text: string, what = "Copied") {
  navigator.clipboard.writeText(text).then(
    () => toast.show({ title: what, duration: 2000 }),
    () => toast.error("Couldn't copy to the clipboard"),
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={label}
      size="icon-xs"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => toast.error("Couldn't copy to the clipboard"),
        );
      }}
    >
      {done ? <CheckIcon className="text-success-foreground" /> : <CopyIcon />}
    </IconButton>
  );
}

/** The line people paste into their agent: where to read, nothing secret or personal. */
export function agentPrompt(guidePath: string): string {
  return `Fancy Mail is my email app. Read "${guidePath}" and follow it to connect to my mail.`;
}

function CopyLabelButton({ text, children }: { text: string; children: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost-muted"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => toast.error("Couldn't copy to the clipboard"),
        );
      }}
    >
      {done ? <CheckIcon className="text-success-foreground" /> : <CopyIcon />}
      {done ? "Copied" : children}
    </Button>
  );
}

export function AgentsSettings() {
  const { data: bootstrap } = useBootstrap();
  const dir = useDirectory();
  const [reveal, setReveal] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  if (!bootstrap) return null;
  const { mcp, settings } = bootstrap;

  const masked = mcp.token ? `${mcp.token.slice(0, 4)}${"•".repeat(Math.max(8, Math.min(28, mcp.token.length - 8)))}${mcp.token.slice(-4)}` : "";
  const claudeCommand = `claude mcp add --transport http fancy-mail ${mcp.url} --header "Authorization: Bearer ${mcp.token}"`;
  const mcpJson = JSON.stringify(
    { mcpServers: { "fancy-mail": { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } },
    null,
    2,
  );
  const shownCommand = reveal ? claudeCommand : claudeCommand.replace(mcp.token, masked);
  const shownJson = reveal ? mcpJson : mcpJson.replace(mcp.token, masked);
  const prompt = agentPrompt(mcp.guidePath);

  const rotate = async () => {
    setRotating(true);
    try {
      const info = await rpc("mcp.rotateToken", {});
      const current = queryClient.getQueryData<typeof bootstrap>(qk.bootstrap);
      if (current) queryClient.setQueryData(qk.bootstrap, { ...current, mcp: info });
      setConfirmRotate(false);
      toast.show({ title: "New token made", description: "Agents using the old one are disconnected. Update their setup.", duration: 6000 });
    } catch (error) {
      toast.error("Couldn't make a new token", errorMessage(error));
    } finally {
      setRotating(false);
    }
  };

  const groupsWithAccounts = [
    ...dir.groups.map((g) => ({ id: g.id as string | null, name: g.name, color: g.color as string | null, accounts: dir.accounts.filter((a) => a.groupId === g.id) })),
    { id: null, name: "Ungrouped", color: null, accounts: dir.accounts.filter((a) => !a.groupId || !dir.groupById.has(a.groupId)) },
  ].filter((g) => g.accounts.length > 0);

  return (
    <>
      <div className="space-y-2 px-3 sm:px-4">
        <h2 className="font-semibold text-base">Agents</h2>
        <p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
          Fancy Mail has no AI built in. Agents you already use, like Claude Code or T3 Code, connect over MCP to search, read, label, archive and draft — and every change they make shows in{" "}
          <InlineButton tone="default" onClick={() => navigate({ page: "activity" })}>
            Activity
          </InlineButton>{" "}
          with Undo.
        </p>
      </div>

      <SettingsSection title="Connection">
        <SettingsRow
          title="Allow agents"
          description="When off, the MCP server turns every agent away."
          control={
            <Switch
              checked={settings.mcp.enabled}
              onCheckedChange={(enabled) => void updateSettings({ mcp: { ...settings.mcp, enabled } })}
              aria-label="Allow agents"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Set up an agent"
        description="Paste this into Claude Code, Codex, T3 Code or any other agent. It tells the agent where Fancy Mail keeps the setup, so the token isn't in it."
      >
        <div className="space-y-2 px-3 py-3 sm:px-4">
          <CodeBlock code={prompt} wrap label="For your agent" action={<CopyLabelButton text={prompt}>Copy</CopyLabelButton>} />
          {settings.mcp.enabled ? null : <p className="text-muted-foreground text-xs">Turn on Allow agents first. The setup is only there while agents are allowed.</p>}
        </div>
        <Collapsible>
          <CollapsibleTrigger className="group flex h-11 w-full items-center gap-2 px-3 text-start text-muted-foreground text-sm transition-colors hover:text-foreground sm:px-4">
            <ChevronRightIcon className="size-4 shrink-0 transition-transform duration-150 group-data-[panel-open]:rotate-90" />
            <span className="font-medium">Advanced</span>
            <span className="truncate text-muted-foreground/70 text-xs">Address, token and configs, to set up by hand</span>
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="border-border/50 border-t [&>*+*]:border-border/50 [&>*+*]:border-t [&>[data-slot=settings-row]]:rounded-none">
              <SettingsRow
                title="Address"
                control={
                  <span className="flex min-w-0 items-center gap-1">
                    <code className="truncate rounded-md bg-white/[0.05] px-2 py-1 font-mono text-xs" data-selectable>
                      {mcp.url}
                    </code>
                    <CopyButton text={mcp.url} label="Copy address" />
                  </span>
                }
              />
              <SettingsRow
                title="Token"
                description="Agents send it with every request. Anyone with it can act as an agent, within each account's access."
                control={
                  <span className="flex min-w-0 items-center gap-1">
                    <code className="max-w-56 truncate rounded-md bg-white/[0.05] px-2 py-1 font-mono text-xs" data-selectable>
                      {reveal ? mcp.token : masked}
                    </code>
                    <IconButton label={reveal ? "Hide token" : "Show token"} size="icon-xs" onClick={() => setReveal((r) => !r)}>
                      {reveal ? <EyeOffIcon /> : <EyeIcon />}
                    </IconButton>
                    <CopyButton text={mcp.token} label="Copy token" />
                    <Button size="xs" variant="outline" onClick={() => setConfirmRotate(true)}>
                      <RotateCwIcon />
                      Rotate
                    </Button>
                  </span>
                }
              />
              <div className="space-y-3 px-3 py-3 sm:px-4">
                <CodeBlock code={shownCommand} label="Claude Code (terminal)" action={<CopyButton text={claudeCommand} label="Copy command" />} />
                <CodeBlock code={shownJson} label=".mcp.json (Claude Code, T3 Code, other MCP clients)" action={<CopyButton text={mcpJson} label="Copy .mcp.json" />} />
              </div>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </SettingsSection>

      <SettingsSection title="What agents may do">
        <SettingsRow
          title="New accounts start at"
          description={AGENT_ACCESS_INFO[settings.defaultAgentAccess].description}
          control={
            <FieldSelect<AgentAccess>
              items={ACCESS_CHOICES}
              value={settings.defaultAgentAccess}
              onChange={(defaultAgentAccess) => void updateSettings({ defaultAgentAccess })}
              ariaLabel="New accounts start at"
              size="sm"
            />
          }
        />
        {groupsWithAccounts.map((group) => (
          <div key={group.id ?? "none"} className="px-3 py-2.5 sm:px-4">
            <div className="flex h-8 items-center gap-2">
              <ColorDot color={group.color} />
              <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-xs">{group.name}</span>
              <Menu>
                <MenuTrigger render={<Button size="xs" variant="ghost-muted" />}>Set all</MenuTrigger>
                <MenuPopup align="end" className="w-64">
                  {ACCESS_CHOICES.map((choice) => (
                    <MenuItem
                      key={choice.value}
                      onClick={() => {
                        for (const account of group.accounts) {
                          if (account.agentAccess !== choice.value) void updateAccount(account.id, { agentAccess: choice.value });
                        }
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block">{choice.label}</span>
                        <span className="block text-muted-foreground text-xs">{choice.description}</span>
                      </span>
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
            <div className="space-y-0.5">
              {group.accounts.map((account) => (
                <div key={account.id} className="flex h-10 items-center gap-2.5">
                  <AccountAvatar account={account} size={20} />
                  <span className="min-w-0 flex-1 truncate text-sm" title={account.email}>
                    {account.email}
                  </span>
                  <FieldSelect<AgentAccess>
                    items={ACCESS_CHOICES}
                    value={account.agentAccess}
                    onChange={(agentAccess) => void updateAccount(account.id, { agentAccess })}
                    ariaLabel={`Agent access for ${account.email}`}
                    size="sm"
                    className="w-40"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>

      <SettingsSection
        title="Connected agents"
        action={
          <Button size="sm" variant="ghost-muted" onClick={() => navigate({ page: "activity" })}>
            <HistoryIcon />
            Activity
          </Button>
        }
      >
        {mcp.clients.length === 0 ? (
          <div className="px-4 py-4 text-muted-foreground text-sm">No agent is connected right now.</div>
        ) : (
          mcp.clients.map((client) => (
            <div key={client.sessionId} className="flex items-center gap-3 px-4 py-2.5">
              <span className="size-2 shrink-0 rounded-full bg-success" />
              <span className="min-w-0 flex-1 truncate text-sm">
                {prettifyAgentName(client.name)}
                {client.version ? <span className="ms-2 text-muted-foreground text-xs">{client.version}</span> : null}
              </span>
              <span className="shrink-0 text-muted-foreground text-xs">connected {formatRelative(client.connectedAt)}</span>
            </div>
          ))
        )}
      </SettingsSection>

      <AlertDialog open={confirmRotate} onOpenChange={(open) => !rotating && setConfirmRotate(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Make a new token?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents set up with the current token stop working until you give them the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={rotating} />}>Cancel</AlertDialogClose>
            <Button onClick={() => void rotate()} disabled={rotating}>
              Make new token
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

