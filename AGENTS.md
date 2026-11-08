# Fancy Mail

Fancy Mail is a calm, fast desktop email client for someone with dozens of accounts. Accounts
sit in groups (Banking, Channels, Business, Personal…), every group has its own inbox, and
everything is searchable in one place. All mail lives on this computer, in one SQLite file.

It deliberately has **no AI features inside it**. Instead it runs an **MCP server**, so an
agent the user already has (Claude Code, T3 Code) can search, read, label, archive and draft
from the outside, with every change visible in the app and undoable. The client stays a
client; intelligence plugs in.

Its stack, structure and look follow [T3 Code](https://github.com/pingdotgg/t3code): a local
Node server owns the state and talks to a React client over a WebSocket; Electron wraps both.

## What we never compromise on

1. **The user's mail is safe.** Nothing deletes mail on a server except an explicit, visible
   user action. Credentials are encrypted at rest. A failing sign-in never removes an account
   or its credentials: it shows "Reconnect", and the mail already downloaded stays readable.
2. **Fast and calm.** Lists are virtualized, every change is applied locally first and synced
   after, nothing blocks on the network. No spinners where a cached answer exists.
3. **One model, many doors.** The sidebar, the search box, the command palette, keyboard
   shortcuts and the MCP tools all go through the same service methods and the same query
   language. A view is a query. An agent sees what the user sees.
4. **Agents are guests.** Each account has an agent access level (`none` → `send`). Agents
   cannot send unless the user allowed it for that account. Every agent change is logged in
   Activity with Undo, and shows as a toast while the app is open. Email content is untrusted
   input to an agent; tool descriptions say so.
5. **No lock-in.** Labels are mirrored to the server (Gmail labels, IMAP keywords), so the
   organization survives this app.

## How it works

```
apps/desktop  Electron shell: starts the server with Electron's Node, loads the UI, tray,
              updates, the vault key (safeStorage).
apps/server   Node server (runs on Electron's Node 24: node:sqlite with FTS5).
              db/        SQLite schema and migrations
              store/     SQL for each table, no logic
              search/    query language → SQL
              services/  everything the app can do; the only place with business rules
              sync/      IMAP/SMTP/OAuth, account workers, the outbox that pushes local changes
              transport/ HTTP (static UI, attachments, uploads), WebSocket RPC
              mcp/       MCP server: tools are thin wrappers over services
              demo/      the demo accounts seeded on first run
apps/web      React client (Vite, Tailwind 4, Base UI, TanStack Query, zustand)
packages/contracts  zod schemas and types for everything crossing a process boundary,
              the RPC method table, server events, the query parser, views, provider presets
```

- The client sends `{ id, method, params }` over `/ws`; `packages/contracts/src/rpc.ts`
  declares every method with zod schemas. The server validates params, calls **one service
  method**, and maps errors to `{ code, message }`. The server pushes `ServerEvent`s; the
  client refetches what an `invalidate` names. The client keeps no other state of its own.
- Local-first writes: a service updates SQLite in one transaction, records the Activity (with
  its inverse for Undo), enqueues an outbox op for the account's sync worker, then publishes
  `invalidate`. The worker applies the op on the server and retries with backoff.
- Threads are per account (Gmail thread id, or References/In-Reply-To). A label, inbox state,
  star or read state shown on a thread is derived from its messages; `threads` and
  `thread_labels` are a denormalized cache rebuilt by `refreshThreads()`.
- Search: `parseQuery` (contracts) → `compileQuery` (server) → one SQL statement over
  `threads`, with FTS5 for words. Without `in:`, trash and spam are excluded.

## Dev

- `pnpm dev` — Vite, the desktop shell, and the server (with demo data in `.dev-data/`).
- `pnpm dev:browser` — server + Vite only; open the printed URL in a browser.
- `pnpm test` — vitest, run on Electron's Node (`scripts/electron-node.mjs`), because the
  server needs `node:sqlite` with FTS5, which the system Node may not have.
- `pnpm typecheck`, `pnpm build`, `pnpm snapshot` (renders the main views to
  `snapshots/latest/*.png` for a visual check), `pnpm dist`, `pnpm release`.
- Server code runs as TypeScript directly (Node's type stripping): only erasable syntax (no
  `enum`, no parameter properties, no namespaces), `import type` for types, and `.ts`
  extensions on relative imports.

## Shipping a change

The repository is public, and the installed app updates itself from its GitHub Releases (the
update button; checked 10 s after start and every 4 minutes). A change reaches the person when:

1. it is committed on `main` with typecheck and tests passing;
2. `"version"` is bumped in all five package.json files (root, apps/*, packages/contracts);
3. that is committed and pushed, then `pnpm release` (tags vX.Y.Z, builds, uploads the
   installer, its .blockmap and latest.yml). Check the feed afterwards:
   https://github.com/OtakuGamerAds/fancy-mail/releases/latest/download/latest.yml

Because it is public, nothing personal goes in: demo data stays fictional (`.example`
domains, made-up people), no real names, addresses, paths or tokens.

## The ways to hurt yourself

1. **Touching the user's real data.** The installed app keeps its data in
   `%APPDATA%/Fancy Mail`. Never point a dev server, a test or a script at it. Dev uses
   `.dev-data/`, tests use a temp dir.
2. **Killing by pattern.** Only kill a process you started, by the PID you captured.
3. **Leaking secrets.** Never log passwords, OAuth tokens, the vault key or the MCP token.
   Error messages that reach the UI or an agent must not echo credentials.

## Taste

- Complexity belongs at the sync boundary. Services stay plain, the UI stays dumb.
- Transports stay thin: a WebSocket handler, an HTTP route or an MCP tool decodes input, calls
  one service method, and maps errors.
- Reverse states: every way in has a way out and a way to see it (archive/move to inbox,
  trash/restore, label/unlabel, pause/resume, hide from agents/show).
- Hit every surface: a feature reachable from the toolbar is usually also in the context menu,
  the command palette, a keybinding, and — if it changes mail — an MCP tool.
- `apps/web/src/components/ui` are T3 Code's primitives (MIT, see
  `THIRD_PARTY_LICENSE_T3CODE.txt`). Pick a `variant`/`size`; don't restyle them with
  `className`. Layout classes belong on the parent.
- Product text is short, plain, sentence case. Errors say what happened and what to do.
- Tests: behavior that can break (query compile, modify/undo, sync state, MCP permissions,
  MIME parsing). Not what types already guarantee. No sleeps in tests.
- Commits: plain sentences describing what the user gets, like the history of Fancy Dictator.
