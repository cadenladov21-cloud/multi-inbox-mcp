# Multi-Inbox MCP

**One Claude connector for all your email inboxes.** It links any number of Gmail and Outlook accounts. Then one *"brief me on my email"* covers every inbox: in Claude chat, on mobile, in morning briefings like Duet, and in Claude Code.

Claude's built-in email connectors see one account each. This one sees them all.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cadenladov21-cloud/multi-inbox-mcp)

> **Set up your own copy → [SETUP.md](SETUP.md)** (about 45 minutes, no coding, free hosting on Cloudflare). The button above handles the Cloudflare part; you still create a Google sign-in app (step 3).

## What Claude can do

| Tool | What it does |
|---|---|
| `inbox_digest` | Recent mail from **every** inbox in one call, grouped by inbox. Built for morning briefings. |
| `search_email` | Search one inbox, or all of them at once. |
| `read_email` / `read_thread` | A full message or a whole conversation. |
| `create_draft` | A new email or a reply, saved as a draft in the inbox you choose. |
| `send_email` | Sends right away. **Off until you turn it on** in the dashboard; Claude is told to confirm with you first. |
| `update_email` | Archive, mark read/unread, star, or trash messages, in bulk. |
| `list_accounts` | Which inboxes are linked. |

You can point Claude at one inbox by address, by nickname ("work"), or by provider ("gmail"), or say "all".

## How it works

```
Claude ──(OAuth 2.1 + MCP over HTTPS)──▶ Cloudflare Worker ──▶ Gmail API
                                             │                ──▶ Microsoft Graph (Outlook)
                                             └─ Workers KV: accounts, linked inboxes,
                                                encrypted sign-in tokens
```

- **`src/index.ts`**: the entry point. [`@cloudflare/workers-oauth-provider`](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider) makes the Worker an OAuth server for Claude: discovery, client metadata documents, dynamic registration, PKCE and tokens.
- **`src/web.ts`**: the connect flow Claude opens (consent → first inbox → add more → done), the dashboard, and the 30-minute links for adding an inbox from another browser.
- **`src/mcp.ts`**: the MCP tools. A fresh, stateless server is built per request for the signed-in user. Reads across inboxes run in parallel, and one broken inbox doesn't fail the whole call.
- **`src/providers/`**: the Gmail and Outlook adapters behind one interface, plus a fake provider for tests.
- **`src/store.ts`**: accounts and linked inboxes. Sign-in tokens are encrypted with AES-GCM. Outlook's rotating refresh tokens are saved on every refresh.

## Privacy and security

- **Your copy, your data.** Each person runs their own server; there's no central service.
- **Tokens never reach Claude.** Inbox sign-in tokens are stored only encrypted. Claude gets its own token, which only works with this server.
- **Email isn't stored.** Messages are fetched when Claude asks and passed straight through.
- **Hardened sign-in pages.** The consent pages are tied to your browser and can't be embedded in other sites, following MCP's security guidance.
- **Drafts only by default.** Dashboard forms are protected against other sites submitting them.
- **Least access.** Gmail uses the `gmail.modify` permission, which can't permanently delete mail. Outlook uses `Mail.ReadWrite` + `Mail.Send`.

## Development

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

Fill in the secrets from `npm run gen-secrets` and set `ENABLE_MOCK_PROVIDER=true`. Then start the server:

```bash
npm run dev
```

In a second terminal, run the tests:

```bash
npm run e2e
```

```bash
npm test
```

```bash
npm run typecheck
```

`npm run e2e` connects like Claude does, links fake inboxes in two "browsers", and calls every tool. `npm test` checks the Gmail and Outlook adapters against sample API responses.

## Ideas / contributions welcome

- IMAP inboxes (iCloud, Yahoo, Fastmail) via app passwords
- Calendars from the same linked accounts
- An "important senders" filter for briefings

## License

[MIT](LICENSE)
