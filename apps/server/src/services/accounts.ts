import fs from "node:fs";
import path from "node:path";

import { COLOR_PALETTE, domainOf, presetForEmail } from "@fancy-mail/contracts";
import type { Account, AccountStatus, AgentAccess, Provider, ProviderDetection, ServerEndpoint } from "@fancy-mail/contracts";

import { newId } from "../db/ids.ts";
import { AppError } from "../errors.ts";
import type { AccountRecord } from "../store/types.ts";
import { canSee, isAgent, requireAccess, requireUser, visibleAccountIds } from "./context.ts";
import type { CallContext } from "./context.ts";
import { invalidate, writeActivity } from "./env.ts";
import type { ServiceEnv } from "./env.ts";
import { validColor } from "./labels.ts";

const IDLE: AccountStatus = { state: "idle", message: null, lastSyncAt: null, progress: null };

export function createAccountsService(env: ServiceEnv, settings: () => { defaultAgentAccess: AgentAccess }) {
  const { store } = env;

  function toAccount(a: AccountRecord, unread: Map<string, number>): Account {
    return {
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      provider: a.provider,
      authKind: a.authKind,
      groupId: a.groupId,
      color: a.color,
      sortOrder: a.sortOrder,
      agentAccess: a.agentAccess,
      signature: a.signature,
      imap: a.imap,
      smtp: a.smtp,
      status: a.status,
      unreadInboxCount: unread.get(a.id) ?? 0,
      createdAt: a.createdAt,
    };
  }

  function requireAccount(id: string, ctx?: CallContext): AccountRecord {
    const a = store.accounts.get(id);
    if (!a || (ctx && !canSee(ctx, a))) throw new AppError("not_found", `No account with id ${id}. It may have been removed.`);
    return a;
  }

  function nextColor(): string {
    const used = store.accounts.list().map((a) => a.color);
    return COLOR_PALETTE.find((c) => !used.includes(c)) ?? COLOR_PALETTE[used.length % COLOR_PALETTE.length]!;
  }

  function requireGroup(groupId: string | null | undefined): string | null {
    if (groupId === undefined || groupId === null) return null;
    if (!store.groups.get(groupId)) throw new AppError("not_found", `No group with id ${groupId}. It may have been deleted.`);
    return groupId;
  }

  function changed(id: string): void {
    invalidate(env, ["accounts", "groups"]);
    try {
      env.sync().accountUpdated(id);
    } catch (error) {
      env.log.warn("sync engine failed on accountUpdated", { accountId: id, error });
    }
  }

  const service = {
    list(ctx?: CallContext): Account[] {
      const unread = store.accounts.unreadInboxCounts(store.settings.get().inboxTabs);
      const all = store.accounts.list();
      const visible = ctx ? visibleAccountIds(ctx, all) : null;
      const groupOrder = new Map(store.groups.list().map((g, i) => [g.id, i]));
      return all
        .filter((a) => !visible || visible.includes(a.id))
        .sort((a, b) => {
          const ga = a.groupId === null ? Number.MAX_SAFE_INTEGER : (groupOrder.get(a.groupId) ?? Number.MAX_SAFE_INTEGER - 1);
          const gb = b.groupId === null ? Number.MAX_SAFE_INTEGER : (groupOrder.get(b.groupId) ?? Number.MAX_SAFE_INTEGER - 1);
          return ga - gb || a.sortOrder - b.sortOrder || a.createdAt - b.createdAt;
        })
        .map((a) => toAccount(a, unread));
    },

    get(id: string, ctx?: CallContext): Account {
      return toAccount(requireAccount(id, ctx), store.accounts.unreadInboxCounts(store.settings.get().inboxTabs));
    },

    /** The stored record (with username, paused, isDemo) for the sync engine. */
    record(id: string): AccountRecord | null {
      return store.accounts.get(id);
    },

    /** By id, email or display name (case-insensitive). */
    resolve(emailOrNameOrId: string, ctx?: CallContext): Account | null {
      const wanted = emailOrNameOrId.trim().toLocaleLowerCase();
      const all = store.accounts.list().filter((a) => !ctx || canSee(ctx, a));
      const found =
        all.find((a) => a.id === emailOrNameOrId.trim()) ??
        all.find((a) => a.email.toLocaleLowerCase() === wanted) ??
        all.find((a) => a.displayName.toLocaleLowerCase() === wanted) ??
        null;
      return found ? toAccount(found, store.accounts.unreadInboxCounts(store.settings.get().inboxTabs)) : null;
    },

    detect(email: string): ProviderDetection {
      const preset = presetForEmail(email);
      if (preset) {
        return {
          provider: preset.provider,
          presetId: preset.id,
          name: preset.name,
          imap: preset.imap,
          smtp: preset.smtp,
          auth: preset.auth.filter((k): k is "password" | "oauth-google" | "oauth-microsoft" => k !== "none"),
          appPasswordUrl: preset.appPasswordUrl,
          passwordHint: preset.passwordHint,
        };
      }
      const domain = domainOf(email);
      return {
        provider: "imap",
        presetId: null,
        name: domain || "Other",
        imap: domain ? { host: `imap.${domain}`, port: 993, secure: true } : null,
        smtp: domain ? { host: `smtp.${domain}`, port: 465, secure: true } : null,
        auth: ["password"],
        appPasswordUrl: null,
        passwordHint: domain ? `Check the server names with your provider; these are guesses for ${domain}. For Google Workspace, pick Gmail.` : null,
      };
    },

    async addWithPassword(
      input: {
        email: string;
        displayName: string;
        password: string;
        provider: Provider;
        imap: ServerEndpoint;
        smtp: ServerEndpoint;
        username?: string;
        groupId?: string | null;
      },
      ctx: CallContext,
    ): Promise<Account> {
      requireUser(ctx, "add accounts");
      const email = input.email.trim();
      if (store.accounts.findByEmail(email)) throw new AppError("conflict", `${email} is already in Fancy Mail.`);
      const groupId = requireGroup(input.groupId);
      const username = input.username?.trim() || email;
      await env.sync().testPasswordAccount({ email, username, password: input.password, imap: input.imap, smtp: input.smtp });
      // The sign-in may have taken a while: check again before saving.
      if (store.accounts.findByEmail(email)) throw new AppError("conflict", `${email} is already in Fancy Mail.`);
      const id = newId("acc");
      env.db.tx(() => {
        store.accounts.insert({
          id,
          email,
          displayName: input.displayName.trim() || email,
          username,
          provider: input.provider === "demo" ? "imap" : input.provider,
          authKind: "password",
          groupId,
          color: nextColor(),
          sortOrder: store.accounts.nextSortOrder(groupId),
          agentAccess: settings().defaultAgentAccess,
          signature: "",
          imap: input.imap,
          smtp: input.smtp,
          status: { ...IDLE, state: "connecting", message: "Connecting…" },
          paused: false,
          isDemo: false,
          createdAt: env.now(),
        });
        env.vault.put(id, "password", input.password);
      });
      invalidate(env, ["accounts", "groups", "mailboxes"]);
      env.sync().accountAdded(id);
      return service.get(id);
    },

    async startOAuth(input: { provider: "google" | "microsoft"; accountId?: string; groupId?: string | null }, ctx: CallContext) {
      requireUser(ctx, "add or reconnect accounts");
      if (input.accountId) requireAccount(input.accountId);
      requireGroup(input.groupId);
      return env.sync().startOAuth(input);
    },

    cancelOAuth(input: { flowId: string }, ctx: CallContext): void {
      requireUser(ctx, "cancel a sign-in");
      env.sync().cancelOAuth(input.flowId);
    },

    async reconnect(input: { accountId: string; password: string }, ctx: CallContext): Promise<Account> {
      requireUser(ctx, "reconnect accounts");
      const account = requireAccount(input.accountId);
      if (account.isDemo) throw new AppError("bad_request", "Demo accounts don't sign in anywhere.");
      if (!account.imap || !account.smtp) throw new AppError("bad_request", `${account.email} signs in with ${account.authKind === "oauth-microsoft" ? "Microsoft" : "Google"}. Use "Sign in again" instead.`);
      await env.sync().testPasswordAccount({
        email: account.email,
        username: account.username,
        password: input.password,
        imap: account.imap,
        smtp: account.smtp,
      });
      env.db.tx(() => {
        env.vault.put(account.id, "password", input.password);
        store.accounts.setStatus(account.id, { ...account.status, state: "connecting", message: "Connecting…" });
      });
      service.publishStatus(account.id);
      changed(account.id);
      return service.get(account.id);
    },

    update(
      input: {
        accountId: string;
        displayName?: string;
        color?: string;
        groupId?: string | null;
        agentAccess?: AgentAccess;
        signature?: string;
        paused?: boolean;
      },
      ctx: CallContext,
    ): Account {
      const account = requireAccount(input.accountId, ctx);
      if (isAgent(ctx)) {
        if (input.agentAccess !== undefined && input.agentAccess !== account.agentAccess) requireUser(ctx, "change what agents may do");
        if (input.paused !== undefined && input.paused !== account.paused) requireUser(ctx, "pause or resume accounts");
        if (input.signature !== undefined && input.signature !== account.signature) requireUser(ctx, "change signatures");
        requireAccess(ctx, account, "organize", "changing the account");
      }
      const groupId = input.groupId === undefined ? undefined : requireGroup(input.groupId);
      const color = validColor(input.color, "The account") ?? undefined;
      const displayName = input.displayName?.trim();
      if (displayName !== undefined && !displayName) throw new AppError("bad_request", "An account needs a name.");
      const pausedChanged = input.paused !== undefined && input.paused !== account.paused;
      env.db.tx(() => {
        store.accounts.update(account.id, {
          displayName,
          color,
          groupId,
          sortOrder: groupId !== undefined && groupId !== account.groupId ? store.accounts.nextSortOrder(groupId) : undefined,
          agentAccess: input.agentAccess,
          signature: input.signature,
          paused: input.paused,
        });
        if (pausedChanged && !account.isDemo) {
          store.accounts.setStatus(
            account.id,
            input.paused
              ? { ...account.status, state: "paused", message: "Paused", progress: null }
              : { ...account.status, state: "connecting", message: "Connecting…", progress: null },
          );
        }
        if (isAgent(ctx) && groupId !== undefined && groupId !== account.groupId) {
          const activity = writeActivity(env, {
            actor: ctx.actor,
            summary: `Moved ${account.email} to ${groupId ? (store.groups.get(groupId)?.name ?? "a group") : "no group"}`,
            kind: "group",
            accountIds: [account.id],
            undo: { type: "groupAssign", accounts: [{ id: account.id, groupId: account.groupId, sortOrder: account.sortOrder }] },
          });
          env.bus.publish({ type: "activity", activity });
        }
      });
      if (pausedChanged) service.publishStatus(account.id);
      if (input.agentAccess !== undefined && input.agentAccess !== account.agentAccess) invalidate(env, ["mcp"]);
      changed(account.id);
      return service.get(account.id);
    },

    reorder(input: { accountIds: string[]; groupId?: string | null }, ctx: CallContext): void {
      const accounts = input.accountIds.map((id) => requireAccount(id, ctx));
      const groupId = input.groupId === undefined ? undefined : requireGroup(input.groupId);
      if (isAgent(ctx)) for (const a of accounts) requireAccess(ctx, a, "organize", "moving accounts");
      env.db.tx(() => {
        accounts.forEach((a, index) => {
          store.accounts.update(a.id, { sortOrder: index, groupId });
        });
      });
      invalidate(env, ["accounts", "groups"]);
    },

    remove(input: { accountId: string }, ctx: CallContext): void {
      requireUser(ctx, "remove accounts");
      const account = requireAccount(input.accountId);
      const files = store.messages.attachmentPathsForAccount(account.id);
      env.db.tx(() => {
        // Messages, mailboxes, threads, drafts and outbox ops cascade with the account.
        store.accounts.delete(account.id);
        env.vault.delete(account.id);
      });
      removeFiles(env, files, path.join(env.paths.attachments, account.id));
      invalidate(env, ["accounts", "groups", "labels", "mailboxes", "threads", "drafts"]);
      try {
        env.sync().accountRemoved(account.id);
      } catch (error) {
        env.log.warn("sync engine failed on accountRemoved", { accountId: account.id, error });
      }
    },

    syncNow(input: { accountId?: string }, ctx: CallContext): void {
      if (input.accountId) requireAccount(input.accountId, ctx);
      env.sync().syncNow(input.accountId);
    },

    /** Internal (sync engine): stores and publishes an account's status. */
    setStatus(accountId: string, status: AccountStatus): void {
      if (!store.accounts.get(accountId)) return;
      store.accounts.setStatus(accountId, status);
      env.bus.publish({ type: "accountStatus", accountId, status });
    },

    publishStatus(accountId: string): void {
      const a = store.accounts.get(accountId);
      if (a) env.bus.publish({ type: "accountStatus", accountId, status: a.status });
    },
  };
  return service;
}

/** Whether a path is inside the data directory (we never delete anything outside it). */
export function insideDataDir(env: ServiceEnv, file: string): boolean {
  const root = path.resolve(env.dataDir) + path.sep;
  return path.resolve(file).startsWith(root);
}

/** Deletes files (and then the directory) inside the data directory, without failing the caller. */
export function removeFiles(env: ServiceEnv, files: string[], dir: string | null): void {
  for (const file of files) {
    if (!insideDataDir(env, file)) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      env.log.warn("could not delete a file", { file, error });
    }
  }
  if (dir && insideDataDir(env, dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      env.log.warn("could not delete a directory", { dir, error });
    }
  }
}

export type AccountsService = ReturnType<typeof createAccountsService>;
