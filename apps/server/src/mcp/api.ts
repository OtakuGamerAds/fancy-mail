/**
 * What the MCP tools need from the app, and nothing more. `adapter.ts` implements it with the
 * services; tests can implement it directly. Every call that changes something or reads mail
 * takes the acting agent, so the services can enforce each account's access level and record
 * who did it.
 */
import type {
  Account,
  Activity,
  Actor,
  AttachmentMeta,
  Draft,
  DraftInput,
  Group,
  Label,
  ModifyAction,
  SearchResult,
  Settings,
  ThreadDetail,
} from "@fancy-mail/contracts";

export interface McpMailApi {
  settings(): Settings;
  accounts(): Account[];
  groups(): Group[];
  labels(): Label[];

  search(input: { query: string; cursor: string | null; limit: number }, actor: Actor): SearchResult;
  getThread(threadId: string, actor: Actor): ThreadDetail;
  /** Downloads missing bodies of the thread; resolves when they are in or after `timeoutMs`. */
  ensureBodies(threadId: string, actor: Actor, timeoutMs: number): Promise<void>;
  modify(threadIds: string[], actions: ModifyAction[], actor: Actor): { activity: Activity | null };

  createLabel(input: { name: string; color: string | null }, actor: Actor): Label;
  updateLabel(input: { labelId: string; name?: string; color?: string | null }, actor: Actor): Label;
  deleteLabel(labelId: string, actor: Actor): void;

  createGroup(input: { name: string; color?: string }, actor: Actor): Group;
  updateGroup(input: { groupId: string; name?: string; color?: string }, actor: Actor): Group;
  deleteGroup(groupId: string, actor: Actor): void;
  reorderGroups(groupIds: string[], actor: Actor): void;
  /** Moves accounts into a group (null: ungrouped). */
  assignAccounts(accountIds: string[], groupId: string | null, actor: Actor): void;

  attachment(attachmentId: string, actor: Actor): Promise<{ path: string; meta: AttachmentMeta }>;

  drafts(): Draft[];
  saveDraft(input: DraftInput, actor: Actor): Draft;
  deleteDraft(draftId: string, actor: Actor): void;
  sendDraft(draftId: string, actor: Actor): Draft;

  activity(limit: number): Activity[];
  undo(activityId: string, actor: Actor): Activity;
}
