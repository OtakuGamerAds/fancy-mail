/**
 * The query cache is the client's copy of the server. Nothing goes stale by time: the server
 * says what changed (`invalidate` events) and after a reconnect everything is refetched.
 */
import { findSettledLabel, isReservedLabelName } from "@fancy-mail/contracts";
import type { Account, Bootstrap, Group, Label, ThreadDetail, ThreadSummary } from "@fancy-mail/contracts";
import {
  keepPreviousData,
  QueryClient,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
} from "@tanstack/react-query";

import { rpc, RpcClientError } from "~/rpc/client";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (failureCount, error) => {
        if (error instanceof RpcClientError && (error.code === "not_found" || error.code === "forbidden" || error.code === "bad_request")) {
          return false;
        }
        return failureCount < 3;
      },
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 4000),
    },
  },
});

export const qk = {
  bootstrap: ["bootstrap"] as const,
  threadsAll: ["threads"] as const,
  threads: (query: string) => ["threads", query] as const,
  facetsAll: ["facets"] as const,
  facets: (query: string) => ["facets", query] as const,
  threadAll: ["thread"] as const,
  thread: (id: string) => ["thread", id] as const,
  activity: ["activity"] as const,
  drafts: ["drafts"] as const,
  quickSearch: (text: string) => ["quick-search", text] as const,
};

export const PAGE_SIZE = 150;

export type ThreadPages = InfiniteData<{
  threads: ThreadSummary[];
  nextCursor: string | null;
  total: number;
  queryErrors: string[];
}, string | null>;

export function useBootstrap() {
  return useQuery({
    queryKey: qk.bootstrap,
    queryFn: () => rpc("app.bootstrap", {}),
    retry: true,
    retryDelay: 1000,
  });
}

export function getBootstrap(): Bootstrap | undefined {
  return queryClient.getQueryData<Bootstrap>(qk.bootstrap);
}

export function threadsQueryOptions(query: string) {
  return {
    queryKey: qk.threads(query),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      rpc("threads.search", { query, cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
  };
}

/**
 * The rows of a list. While the next view or search loads, the last rows stay (the list then
 * swaps them in one step instead of blinking through a loading state).
 */
export function useThreads(query: string | null) {
  return useInfiniteQuery({
    ...threadsQueryOptions(query ?? ""),
    enabled: query !== null,
    placeholderData: keepPreviousData,
  });
}

/** Where a search's matches are, for the sidebar (nothing while there is no search). */
export function useSearchFacets(search: string) {
  const query = search.trim();
  return useQuery({
    queryKey: qk.facets(query),
    queryFn: () => rpc("threads.facets", { query }),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
  });
}

export function prefetchThreads(query: string) {
  void queryClient.prefetchInfiniteQuery({ ...threadsQueryOptions(query), pages: 1 });
}

export function useThread(threadId: string | null) {
  return useQuery({
    queryKey: qk.thread(threadId ?? ""),
    queryFn: () => rpc("threads.get", { threadId: threadId! }),
    enabled: threadId !== null,
  });
}

export function prefetchThread(threadId: string) {
  void queryClient.prefetchQuery({
    queryKey: qk.thread(threadId),
    queryFn: () => rpc("threads.get", { threadId }),
  });
}

export function getThreadDetail(threadId: string): ThreadDetail | undefined {
  return queryClient.getQueryData<ThreadDetail>(qk.thread(threadId));
}

export function useActivity(enabled = true) {
  return useInfiniteQuery({
    queryKey: qk.activity,
    queryFn: ({ pageParam }) => rpc("activity.list", { cursor: pageParam, limit: 50 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useDrafts() {
  return useQuery({ queryKey: qk.drafts, queryFn: () => rpc("drafts.list", {}) });
}

export function useQuickSearch(text: string) {
  const query = text.trim();
  return useQuery({
    queryKey: qk.quickSearch(query),
    queryFn: () => rpc("threads.search", { query, limit: 8 }),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
  });
}

/** Every summary of a thread cached in any list (the freshest one wins). */
export function findCachedThread(threadId: string): ThreadSummary | undefined {
  const detail = getThreadDetail(threadId);
  if (detail) return detail.thread;
  for (const [, data] of queryClient.getQueriesData<ThreadPages>({ queryKey: qk.threadsAll })) {
    for (const page of data?.pages ?? []) {
      const found = page.threads.find((t) => t.id === threadId);
      if (found) return found;
    }
  }
  return undefined;
}

// ── Lookups over bootstrap ──────────────────────────────────────────────────────────────────

export interface Directory {
  accounts: Account[];
  groups: Group[];
  /** The person's labels (Fancy Mail's own, like Settled, are left out). */
  labels: Label[];
  accountById: Map<string, Account>;
  groupById: Map<string, Group>;
  labelById: Map<string, Label>;
  /** Lower-cased addresses of every account: "me". */
  ownAddresses: Set<string>;
  /** The Settled label (null until something is settled). */
  settledLabelId: string | null;
}

let directoryCache: { source: Bootstrap | undefined; value: Directory } | null = null;

export function directoryOf(bootstrap: Bootstrap | undefined): Directory {
  if (directoryCache && directoryCache.source === bootstrap) return directoryCache.value;
  const accounts = [...(bootstrap?.accounts ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups = [...(bootstrap?.groups ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const all = bootstrap?.labels ?? [];
  const labels = all.filter((l) => !isReservedLabelName(l.name)).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const value: Directory = {
    accounts,
    groups,
    labels,
    accountById: new Map(accounts.map((a) => [a.id, a])),
    groupById: new Map(groups.map((g) => [g.id, g])),
    labelById: new Map(labels.map((l) => [l.id, l])),
    ownAddresses: new Set(accounts.map((a) => a.email.toLowerCase())),
    settledLabelId: findSettledLabel(all)?.id ?? null,
  };
  directoryCache = { source: bootstrap, value };
  return value;
}

export function useDirectory(): Directory {
  const { data } = useBootstrap();
  return directoryOf(data);
}
