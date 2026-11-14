/**
 * Mounts the MCP server on /mcp: the tools (tools.ts) over the services, behind the HTTP
 * transport (http.ts). This file is the only place that knows both sides.
 */
import type { Actor } from "@fancy-mail/contracts";

import type { Logger } from "../log.ts";
import type { McpMount } from "../server.ts";
import type { Services } from "../services/index.ts";
import type { McpMailApi } from "./api.ts";
import { createMcpHttpHandler } from "./http.ts";
import { buildMcpServer } from "./tools.ts";

export function createMailApi(services: Services): McpMailApi {
  const ctx = (actor: Actor) => ({ actor });
  return {
    settings: () => services.settings.get(),
    accounts: () => services.accounts.list(),
    groups: () => services.groups.list(),
    labels: () => services.labels.list(),

    search: (input, actor) => services.threads.search(input, ctx(actor)),
    getThread: (threadId, actor) => services.threads.get(threadId, ctx(actor)),
    ensureBodies: (threadId, actor, timeoutMs) => services.threads.ensureBodies(threadId, ctx(actor), timeoutMs),
    modify: (threadIds, actions, actor) => services.threads.modify(threadIds, actions, ctx(actor)),
    setSummary: (threadId, text, actor) => services.threads.setSummary(threadId, text, ctx(actor)),

    createLabel: (input, actor) => services.labels.create(input, ctx(actor)),
    updateLabel: (input, actor) => services.labels.update(input, ctx(actor)),
    deleteLabel: (labelId, actor) => {
      services.labels.delete({ labelId }, ctx(actor));
    },

    createGroup: (input, actor) => services.groups.create(input, ctx(actor)),
    updateGroup: (input, actor) => services.groups.update(input, ctx(actor)),
    deleteGroup: (groupId, actor) => services.groups.delete({ groupId }, ctx(actor)),
    reorderGroups: (groupIds, actor) => services.groups.reorder({ groupIds }, ctx(actor)),
    assignAccounts: (accountIds, groupId, actor) => services.groups.assignAccounts({ accountIds, groupId }, ctx(actor)),

    attachment: (attachmentId, actor) => services.attachments.open(attachmentId, ctx(actor)),

    drafts: () => services.drafts.list(),
    saveDraft: (input, actor) => services.drafts.save(input, ctx(actor)),
    deleteDraft: (draftId, actor) => services.drafts.delete(draftId, ctx(actor)),
    sendDraft: (draftId, actor) => services.drafts.send(draftId, ctx(actor)),

    activity: (limit) => services.activity.list({ limit }).items,
    undo: (activityId, actor) => services.activity.undo(activityId, ctx(actor)),
  };
}

export function createMcp(deps: { services: Services; log: Logger }): McpMount {
  const { services, log } = deps;
  const api = createMailApi(services);
  const handler = createMcpHttpHandler({
    isEnabled: () => services.settings.get().mcp.enabled,
    token: () => services.mcp.currentToken(),
    setClients: (clients) => services.mcp.setClients(clients),
    buildServer: (actor) => buildMcpServer(api, actor, services.env.version),
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  });
  return { handler: handler.handle, close: handler.close };
}
