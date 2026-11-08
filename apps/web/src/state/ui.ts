/**
 * What the client keeps of its own: where the person is, what is selected, panel sizes and
 * which overlay is open. Mail itself lives in the query cache.
 */
import type { DraftMode } from "@fancy-mail/contracts";
import { create } from "zustand";

import { clamp, safeStorage } from "~/lib/utils";
import { INBOX_ROUTE, type Route } from "./router";

export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 380;
export const SIDEBAR_DEFAULT = 268;
export const LIST_MIN = 320;
export const LIST_MAX = 760;
export const LIST_DEFAULT = 440;

export type ListFilter = "all" | "unread" | "starred" | "attachments";

export interface ComposeState {
  /** An existing draft to continue, or null for a new message. */
  draftId: string | null;
  accountId: string | null;
  to?: string;
  subject?: string;
  /** Changes each time compose opens, so the dialog starts fresh. */
  session: number;
}

export type DialogState =
  | { type: "add-account"; groupId?: string | null }
  | { type: "shortcuts" }
  | { type: "remove-account"; accountId: string }
  | { type: "delete-group"; groupId: string }
  | { type: "delete-label"; labelId: string }
  | { type: "reconnect"; accountId: string }
  | { type: "query-help" };

export interface ReplyRequest {
  threadId: string;
  mode: Exclude<DraftMode, "new">;
  draftId?: string | null;
  nonce: number;
}

interface UiState {
  route: Route;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  listWidth: number;

  /** Typed into the list's search field, per view (cleared when the view changes). */
  listSearch: string;
  listFilter: ListFilter;

  /** Checked conversations (multi-select). */
  selection: string[];
  selectionAnchor: string | null;
  /** The keyboard-focused row. */
  focusedThreadId: string | null;
  /** Which column keyboard actions act on. */
  focusZone: "list" | "reader";

  paletteOpen: boolean;
  paletteSession: number;
  compose: ComposeState | null;
  dialog: DialogState | null;
  activitySheetOpen: boolean;
  /** The label picker for the current selection or open conversation (the `l` key). */
  labelPickerFor: string[] | null;
  replyRequest: ReplyRequest | null;
  /** Group or label being renamed inline in the sidebar. */
  renaming: { kind: "group" | "label" | "account"; id: string } | null;
  /** The newest activity time the person has seen (the footer's dot). */
  activitySeenAt: number;
  /** Activity ids this session can undo with `z`, newest last. */
  undoStack: string[];
  /** Sidebar sections the person collapsed. */
  collapsedSections: Record<string, boolean>;
  /** Accounts expanded to their folders in the sidebar. */
  expandedAccounts: Record<string, boolean>;

  setRoute(route: Route): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
  setListWidth(width: number): void;
  setListSearch(text: string): void;
  setListFilter(filter: ListFilter): void;
  setSelection(ids: string[], anchor?: string | null): void;
  clearSelection(): void;
  setFocusedThread(id: string | null): void;
  setFocusZone(zone: "list" | "reader"): void;
  openPalette(): void;
  closePalette(): void;
  openCompose(compose?: Partial<Omit<ComposeState, "session">>): void;
  closeCompose(): void;
  openDialog(dialog: DialogState): void;
  closeDialog(): void;
  setActivitySheetOpen(open: boolean): void;
  openLabelPicker(threadIds: string[]): void;
  closeLabelPicker(): void;
  requestReply(threadId: string, mode: ReplyRequest["mode"], draftId?: string | null): void;
  clearReplyRequest(): void;
  setRenaming(renaming: UiState["renaming"]): void;
  markActivitySeen(at: number): void;
  pushUndo(activityId: string): void;
  dropUndo(activityId: string): void;
  toggleSection(key: string): void;
  toggleAccountExpanded(accountId: string): void;
}

const stored = {
  sidebarCollapsed: safeStorage.get<boolean>("fm.sidebarCollapsed", false),
  sidebarWidth: clamp(safeStorage.get<number>("fm.sidebarWidth", SIDEBAR_DEFAULT), SIDEBAR_MIN, SIDEBAR_MAX),
  listWidth: clamp(safeStorage.get<number>("fm.listWidth", LIST_DEFAULT), LIST_MIN, LIST_MAX),
  activitySeenAt: safeStorage.get<number>("fm.activitySeenAt", 0),
  collapsedSections: safeStorage.get<Record<string, boolean>>("fm.collapsedSections", { more: true }),
  expandedAccounts: safeStorage.get<Record<string, boolean>>("fm.expandedAccounts", {}),
};

let nonce = 0;

export const useUi = create<UiState>()((set, get) => ({
  route: INBOX_ROUTE,
  sidebarCollapsed: stored.sidebarCollapsed,
  sidebarWidth: stored.sidebarWidth,
  listWidth: stored.listWidth,
  listSearch: "",
  listFilter: "all",
  selection: [],
  selectionAnchor: null,
  focusedThreadId: null,
  focusZone: "list",
  paletteOpen: false,
  paletteSession: 0,
  compose: null,
  dialog: null,
  activitySheetOpen: false,
  labelPickerFor: null,
  replyRequest: null,
  renaming: null,
  activitySeenAt: stored.activitySeenAt,
  undoStack: [],
  collapsedSections: stored.collapsedSections,
  expandedAccounts: stored.expandedAccounts,

  setRoute(route) {
    const prev = get().route;
    const prevKey = prev.page === "mail" ? JSON.stringify(prev.view) : prev.page;
    const nextKey = route.page === "mail" ? JSON.stringify(route.view) : route.page;
    if (prevKey !== nextKey) {
      set({ route, listSearch: "", listFilter: "all", selection: [], selectionAnchor: null });
    } else {
      set({ route });
    }
    if (route.page === "mail" && route.threadId) set({ focusedThreadId: route.threadId });
  },
  toggleSidebar() {
    const sidebarCollapsed = !get().sidebarCollapsed;
    safeStorage.set("fm.sidebarCollapsed", sidebarCollapsed);
    set({ sidebarCollapsed });
  },
  setSidebarWidth(width) {
    const sidebarWidth = clamp(Math.round(width), SIDEBAR_MIN, SIDEBAR_MAX);
    safeStorage.set("fm.sidebarWidth", sidebarWidth);
    set({ sidebarWidth });
  },
  setListWidth(width) {
    const listWidth = clamp(Math.round(width), LIST_MIN, LIST_MAX);
    safeStorage.set("fm.listWidth", listWidth);
    set({ listWidth });
  },
  setListSearch: (listSearch) => set({ listSearch }),
  setListFilter: (listFilter) => set({ listFilter, selection: [], selectionAnchor: null }),
  setSelection: (selection, anchor) =>
    set((s) => ({ selection, selectionAnchor: anchor === undefined ? s.selectionAnchor : anchor })),
  clearSelection: () => set({ selection: [], selectionAnchor: null }),
  setFocusedThread: (focusedThreadId) => set({ focusedThreadId }),
  setFocusZone: (focusZone) => set({ focusZone }),
  openPalette: () => set((s) => ({ paletteOpen: true, paletteSession: s.paletteSession + 1 })),
  closePalette: () => set({ paletteOpen: false }),
  openCompose: (compose) =>
    set({
      compose: {
        draftId: compose?.draftId ?? null,
        accountId: compose?.accountId ?? null,
        ...(compose?.to ? { to: compose.to } : {}),
        ...(compose?.subject ? { subject: compose.subject } : {}),
        session: ++nonce,
      },
    }),
  closeCompose: () => set({ compose: null }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
  setActivitySheetOpen: (activitySheetOpen) => set({ activitySheetOpen }),
  openLabelPicker: (labelPickerFor) => set({ labelPickerFor }),
  closeLabelPicker: () => set({ labelPickerFor: null }),
  requestReply: (threadId, mode, draftId) => set({ replyRequest: { threadId, mode, draftId: draftId ?? null, nonce: ++nonce } }),
  clearReplyRequest: () => set({ replyRequest: null }),
  setRenaming: (renaming) => set({ renaming }),
  markActivitySeen(at) {
    if (at <= get().activitySeenAt) return;
    safeStorage.set("fm.activitySeenAt", at);
    set({ activitySeenAt: at });
  },
  pushUndo: (id) => set((s) => ({ undoStack: [...s.undoStack.filter((x) => x !== id), id].slice(-50) })),
  dropUndo: (id) => set((s) => ({ undoStack: s.undoStack.filter((x) => x !== id) })),
  toggleSection(key) {
    const collapsedSections = { ...get().collapsedSections, [key]: !get().collapsedSections[key] };
    safeStorage.set("fm.collapsedSections", collapsedSections);
    set({ collapsedSections });
  },
  toggleAccountExpanded(accountId) {
    const expandedAccounts = { ...get().expandedAccounts, [accountId]: !get().expandedAccounts[accountId] };
    safeStorage.set("fm.expandedAccounts", expandedAccounts);
    set({ expandedAccounts });
  },
}));
