// Server-rendered pages. Everything that might come from a client or a mailbox is escaped.
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { MailProvider } from "./providers/types";
import type { User } from "./store";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const ICON: Record<string, string> = { google: "G", microsoft: "O", mock: "T" };

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Multi-Inbox</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a65;--line:#e4e2dc;--accent:#c4573a;--accent-ink:#fff;--ok:#2f7d4f;--warn:#a5671b}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a18;--card:#242422;--ink:#efede8;--muted:#a3a19a;--line:#3a3935;--accent:#e07a5a;--accent-ink:#1a1a18;--ok:#6cc08f;--warn:#e3a85a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:48px auto;padding:0 16px}
.brand{font-weight:700;letter-spacing:-.01em;margin-bottom:20px;display:flex;gap:8px;align-items:center}
.brand span{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 8px;letter-spacing:-.01em}h2{font-size:16px;margin:0 0 12px}
p{margin:0 0 12px}.muted{color:var(--muted);font-size:14px}
.btn{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:10px 14px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--muted)}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.small{padding:6px 10px;font-size:14px}.btn.link{border:none;background:none;color:var(--muted);padding:6px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.stack>*+*{margin-top:10px}
.acct{display:flex;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}.acct:first-child{border-top:none}
.acct .ic{flex:none;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:var(--bg);font-weight:700}
.acct .who{flex:1;min-width:0}.acct .who b{display:block;overflow:hidden;text-overflow:ellipsis}
.tag{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.tag.warn{color:var(--warn);border-color:var(--warn)}
input[type=text],input[type=email]{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);width:100%}
code,.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:block;overflow-wrap:anywhere}
.warnbox{border-left:3px solid var(--warn);padding:8px 12px;background:var(--bg);border-radius:6px;font-size:14px}
.flash{border-left:3px solid var(--ok);padding:8px 12px;background:var(--card);border-radius:6px;margin-bottom:16px}
form{margin:0}
</style></head><body><main>
<div class="brand"><span>✉</span>Multi-Inbox for Claude</div>
${body}
</main></body></html>`;
}

function providerButtons(providers: MailProvider[], render: (p: MailProvider) => string): string {
  if (!providers.length) {
    return `<p class="warnbox">No email providers are configured on this server yet. Set the Google and/or Microsoft client ID and secret (see the setup guide).</p>`;
  }
  return `<div class="row">${providers.map(render).join("")}</div>`;
}

function accountList(user: User, opts: { editable: boolean }): string {
  if (!user.accounts.length) return `<p class="muted">No inboxes linked yet.</p>`;
  return user.accounts
    .map(
      (a) => `<div class="acct">
  <div class="ic">${ICON[a.provider] ?? "@"}</div>
  <div class="who"><b>${esc(a.email)}</b>
    <span class="muted">${esc(a.provider === "google" ? "Gmail" : a.provider === "microsoft" ? "Outlook" : "Test")}${a.label ? ` · “${esc(a.label)}”` : ""}</span>
    ${a.needsReconnect ? ` <span class="tag warn">needs reconnect</span>` : ""}
  </div>
  ${
    opts.editable
      ? `<form method="post" action="/account/label" class="row" style="flex:none">
      <input type="hidden" name="id" value="${esc(a.id)}">
      <input type="text" name="label" value="${esc(a.label ?? "")}" placeholder="nickname" style="width:110px" aria-label="Nickname for ${esc(a.email)}">
      <button class="btn small">Save</button>
    </form>
    <form method="post" action="/account/remove" onsubmit="return confirm('Disconnect this inbox?')">
      <input type="hidden" name="id" value="${esc(a.id)}"><button class="btn small link">Remove</button>
    </form>`
      : ""
  }
</div>`,
    )
    .join("");
}

export function signInPage(providers: MailProvider[], flash?: string): string {
  return page(
    "Sign in",
    `${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="card">
  <h1>All your inboxes, one connector</h1>
  <p>Connect your Gmail and Outlook accounts so Claude can read, search and draft across all of them at once.</p>
  <p class="muted">Sign in with any inbox you've already linked, or start with a new one.</p>
  ${providerButtons(providers, (p) => `<a class="btn" href="/connect/${p.id}">${ICON[p.id]} Continue with ${esc(p.label)}</a>`)}
</div>`,
  );
}

const maskEmail = (e: string) => e.replace(/^(.)[^@]*/, "$1•••");

export function invitePage(owner: User, providers: MailProvider[], token: string): string {
  const who = owner.accounts[0] ? maskEmail(owner.accounts[0].email) : "your account";
  return page(
    "Add an inbox",
    `<div class="card">
  <h1>Add an inbox</h1>
  <p>This adds an inbox to the Multi-Inbox account of <b>${esc(who)}</b>. Pick the provider, then sign in with the inbox you want to add.</p>
  ${providerButtons(providers, (p) => `<a class="btn primary" href="/add/${esc(token)}/${p.id}">${ICON[p.id]} Add ${esc(p.label)}</a>`)}
  <p class="muted" style="margin-top:12px">If you didn't create this link yourself, close this page.</p>
</div>`,
  );
}

export function inviteDonePage(email: string, total: number): string {
  return page(
    "Inbox added",
    `<div class="card">
  <h1>Added ${esc(email)}</h1>
  <p>Claude now sees ${total} inbox${total === 1 ? "" : "es"}. You can close this tab.</p>
</div>`,
  );
}

export function dashboardPage(user: User, providers: MailProvider[], mcpUrl: string, flash?: string, inviteUrl?: string): string {
  return page(
    "Your inboxes",
    `${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="card">
  <h2>Linked inboxes</h2>
  ${accountList(user, { editable: true })}
  <div style="margin-top:14px">${providerButtons(providers, (p) => `<a class="btn small" href="/connect/${p.id}">+ Add ${esc(p.label)}</a>`)}</div>
  <p class="muted" style="margin-top:12px">Nicknames let you say “check my <i>work</i> inbox”. New inboxes show up in Claude immediately; no need to reconnect.</p>
</div>
<div class="card">
  <h2>Add an inbox from another browser</h2>
  <p class="muted">Signed in to that Gmail or Outlook in a different browser or Chrome profile? Make a link, open it there, and the inbox joins this account. Links work for 30 minutes.</p>
  ${
    inviteUrl
      ? `<code>${esc(inviteUrl)}</code>`
      : `<form method="post" action="/invite"><button class="btn small">Make a link</button></form>`
  }
</div>
<div class="card">
  <h2>Connect to Claude</h2>
  <p class="muted">In Claude, open <b>Settings → Connectors → Add custom connector</b> and paste this URL:</p>
  <code>${esc(mcpUrl)}</code>
</div>
<div class="card">
  <h2>Sending</h2>
  <form method="post" action="/settings" class="row">
    <label class="row" style="flex:1"><input type="checkbox" name="allowSend" value="1" ${user.allowSend ? "checked" : ""}>
    Let Claude send email directly</label>
    <button class="btn small">Save</button>
  </form>
  <p class="muted" style="margin-top:8px">Off: Claude can only create drafts you review and send yourself. On: Claude can send, and is instructed to show you the email and ask first. Takes effect immediately.</p>
</div>
<form method="post" action="/logout"><button class="btn link">Sign out of this page</button></form>`,
  );
}

export function consentPage(d: ConsentDescription, handle: string, user: User | null, providers: MailProvider[]): string {
  const name = esc(d.clientName);
  const hasInboxes = Boolean(user?.accounts.length);
  return page(
    "Connect",
    `<div class="card">
  <h1>Let ${name} use your inboxes?</h1>
  <p class="muted">${d.clientDomain ? `Published by <b>${esc(d.clientDomain)}</b>. ` : "This app registered itself; its name isn't verified. "}Access goes to <b>${esc(d.redirectHost)}</b>.</p>
  ${d.redirectIsLoopback ? `<p class="warnbox">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>` : ""}
  <p>${name} will be able to read and search your linked inboxes, create drafts, and archive or label messages${user?.allowSend ? ", and send email" : ""}.</p>
  ${hasInboxes ? `<p class="muted">Signed in with ${user!.accounts.length} linked inbox${user!.accounts.length > 1 ? "es" : ""}. You can add more on the next screen.</p>` : `<p class="muted">Pick your first inbox. You can add more on the next screen.</p>`}
  <form method="post" action="/authorize" class="stack">
    <input type="hidden" name="handle" value="${esc(handle)}">
    ${
      hasInboxes
        ? `<div class="row"><button class="btn primary" name="decision" value="existing">Allow</button></div>`
        : providerButtons(providers, (p) => `<button class="btn primary" name="decision" value="${p.id}">${ICON[p.id]} Continue with ${esc(p.label)}</button>`)
    }
    <div><button class="btn link" name="decision" value="deny">Cancel</button></div>
  </form>
</div>`,
  );
}

export function connectInboxesPage(user: User, providers: MailProvider[], state: string): string {
  const q = encodeURIComponent(state);
  return page(
    "Your inboxes",
    `<div class="card">
  <h1>Your inboxes</h1>
  <p class="muted">Claude will see all of these. Add every inbox you want in your briefings.</p>
  ${accountList(user, { editable: false })}
  <div style="margin-top:14px">${providerButtons(providers, (p) => `<a class="btn small" href="/authorize/add?provider=${p.id}&amp;state=${q}">+ Add ${esc(p.label)}</a>`)}</div>
</div>
<div class="row"><a class="btn primary" href="/authorize/done?state=${q}">Done, return to Claude</a></div>
<p class="muted" style="margin-top:12px">You can add or remove inboxes later from this site's home page.</p>`,
  );
}

export function mockAuthorizePage(state: string, redirectUri: string): string {
  return page(
    "Test mailbox",
    `<div class="card">
  <h1>Test mailbox (dev only)</h1>
  <p class="muted">This fake provider exists for local testing. Pick any address.</p>
  <form method="get" action="/mock/approve" class="stack">
    <input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
    <input type="email" name="email" value="test@example.com" required aria-label="Email">
    <button class="btn primary">Link this mailbox</button>
  </form>
</div>`,
  );
}

export function errorPage(message: string, homeLink = true): string {
  return page(
    "Something went wrong",
    `<div class="card"><h1>Something went wrong</h1><p>${esc(message)}</p>${homeLink ? `<a class="btn" href="/">Back to start</a>` : ""}</div>`,
  );
}

export function privacyPage(): string {
  return page(
    "Privacy policy",
    `<div class="card stack">
  <h1>Privacy policy</h1>
  <p>Multi-Inbox is a personal tool that lets the Claude assistant read and manage email in inboxes you choose to link.</p>
  <h2>What we access</h2>
  <p>Only the mailboxes you link, using the permissions you grant on Google's or Microsoft's sign-in screen. Email content is fetched when Claude asks for it and passed straight to Claude. It is not stored on this server.</p>
  <h2>What we store</h2>
  <p>Your linked email addresses, the nicknames you set, and encrypted sign-in tokens for each linked inbox. Nothing else.</p>
  <h2>Sharing</h2>
  <p>Data is not sold, shared, or used for advertising or model training. Use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
  <h2>Deleting your data</h2>
  <p>Click <b>Remove</b> next to an inbox on the home page to delete its tokens and revoke access. You can also revoke access any time at myaccount.google.com/permissions.</p>
</div>`,
  );
}

export function termsPage(): string {
  return page(
    "Terms",
    `<div class="card stack">
  <h1>Terms of service</h1>
  <p>Multi-Inbox is provided as-is, without warranty, for personal use. You are responsible for the actions you ask Claude to take in your inboxes. You can stop using it at any time by removing your inboxes and the connector.</p>
</div>`,
  );
}
