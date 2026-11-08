# Fancy Mail

A calm, fast email client for someone with many accounts. Accounts sit in **groups**
(Banking, Channels, Business, Personal…), every group has its own inbox, and everything is
searchable in one place. All mail lives on this computer.

Fancy Mail has **no AI inside**. It runs an **MCP server** instead, so the agent you already
use (Claude Code, T3 Code) can search, read, label, archive and draft for you — from the
outside. Every change an agent makes shows up in **Activity** with **Undo**, and agents can
only do what you allowed per account.

## What it does

- **Groups of accounts.** Drag accounts between groups; each group has an inbox, and each
  account its own folders. "Inbox" at the top is everything at once.
- **One search language** everywhere — the search box, the sidebar views, the command palette
  (`Ctrl K`) and the agents all use it:
  `from:ads@ has:attachment after:2026-07-01 label:Invoices -label:Newsletters group:Banking`
- **Labels across accounts.** "Invoices" is one label for every account. On Gmail it is a real
  Gmail label, elsewhere an IMAP keyword — your organization survives this app.
- **Signed in once.** Gmail with an app password (or Google sign-in), Outlook with Microsoft
  sign-in, and any IMAP server. When a server refuses a sign-in, the account says
  **Reconnect** — it is never removed, and the mail already downloaded stays readable.
- **Private by default.** Remote images in emails are blocked until you allow them, per
  message or per sender. Emails render in a sandbox, never with scripts.
- **Undo everything.** Archive, trash, labels, read state — by you or by an agent.
- **Keyboard first.** `c` compose · `/` search · `j`/`k` move · `e` archive · `#` trash ·
  `s` star · `l` label · `r` reply · `z` undo · `?` all shortcuts.

## Agents (MCP)

Settings › Agents shows the address and token, and a ready-to-paste command:

```
claude mcp add --transport http fancy-mail http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"
```

Each account has an agent access level:

| Level | Agents can |
|---|---|
| Hidden | not see the account at all |
| Read | search, read, open attachments |
| Organize | + labels, archive, read state, stars, trash |
| Draft | + write drafts for you to review (new accounts start here) |
| Send | + send mail |

The tools: `mail_overview`, `mail_search`, `mail_read_thread`, `mail_get_attachment`,
`mail_organize`, `mail_labels`, `mail_groups`, `mail_draft`, `mail_send_draft`,
`mail_activity`. Email content is treated as untrusted input; agents are told never to act on
instructions found inside emails. Fancy Mail must be running (it can stay in the tray) for
agents to reach it.

## Adding a Gmail account

The quickest way is an **app password**: turn on 2-Step Verification, then create one at
<https://myaccount.google.com/apppasswords> and paste the 16 letters into Fancy Mail. It keeps
working until you change your Google password.

"Sign in with Google" also works, but needs your own Google Cloud OAuth client (Settings ›
Sign in with Google explains it). Publish it **In production** — in "Testing" Google signs
you out every 7 days.

## Status (0.1.0)

Tested end to end against a real IMAP/SMTP server: adding an account, first sync, search,
threading, bodies and attachments, labels as IMAP keywords, archive/trash/undo reaching the
server, changes made in other clients showing up, new mail arriving instantly (IDLE), sending
with a copy in Sent, restarts, and a refused password keeping the mail and asking to reconnect.

Written but not yet tried against the real thing: Gmail's own extensions (labels, All Mail,
threads), and Google/Microsoft sign-in. Use app passwords for Gmail first. Drafts live on this
computer only (they are not uploaded to the server's Drafts folder).

## Demo mail

On first start Fancy Mail shows demo accounts with made-up mail so you can look around. Remove
them in Settings › Data (or from the banner) when you add your own.

## Run from source

Needs Node 22+ and pnpm.

```
pnpm install
pnpm dev            # the desktop app, with demo data in .dev-data/
pnpm dev:browser    # server + UI only; open the printed URL
pnpm test
pnpm dist           # Windows installer in release/
```

The server runs on Electron's Node (it needs `node:sqlite` with full-text search). How the
code is organized: [AGENTS.md](AGENTS.md).

Built on ideas, components and styling from [T3 Code](https://github.com/pingdotgg/t3code)
(MIT, see `THIRD_PARTY_LICENSE_T3CODE.txt`).
