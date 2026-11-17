# Setup guide

You'll run your own private copy of Multi-Inbox. It takes about 45 minutes and no coding. You'll need:

- A Mac or PC with [Node.js](https://nodejs.org) 20 or newer
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up) to host the server
- A Google account, to create the "Sign in with Google" app for Gmail
- Optional: a Microsoft account, for Outlook / Hotmail / Microsoft 365

Run every command in Terminal, inside this folder.

---

## 1. Put the server online

**Option A: one click (no Terminal).** Click **[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/cadenladov21-cloud/multi-inbox-mcp)** and sign in to Cloudflare and GitHub. Cloudflare copies this repo to your GitHub and creates the storage. On the deploy page:

- **ENCRYPTION_KEY** and **SESSION_SECRET**: two *different* long random passwords (20+ characters each). A password manager's generator works well. Save them somewhere safe.
- **Google / Microsoft fields**: type `none` for now. You'll fill them in after step 3 under your Worker's **Settings → Variables and secrets**.

Click **Deploy**, then copy your Worker's address (`https://….workers.dev`). This guide calls it `YOUR_URL`. Skip step 2, go to step 3, and wherever a step says `npx wrangler secret put NAME`, edit that secret in the Cloudflare dashboard instead.

**Option B: Terminal.**

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

The login command opens your browser; click **Allow**. The deploy creates the server and its storage, then prints your address, something like `https://multi-inbox.yourname.workers.dev`. **Copy it.** This guide calls it `YOUR_URL`.

> **If this is your first Cloudflare Worker**, Cloudflare has just created your `yourname.workers.dev` address. Brand-new addresses can take a while to reach every part of the internet, so don't add it to Claude until you get to step 5.

## 2. Server secrets

```bash
npm run setup-secrets
```

This generates two random secrets and stores them in Cloudflare without showing them to anyone. Run it **once**. Running it again later would mean re-linking every inbox.

## 3. Google (Gmail)

Go to [console.cloud.google.com](https://console.cloud.google.com).

1. **Create a project** (top bar → project picker → *New project*), for example "Multi-Inbox". If Google shows a welcome screen with Terms of Service, accept them.
2. **Enable the Gmail API**: search "Gmail API" in the top bar → **Enable**.
3. **Google Auth Platform → Get started** (it may be called *OAuth consent screen*):
   - App name: `Multi-Inbox`. Support email: yours.
   - Audience: **External**.
   - Contact email: yours. Agree to the user data policy, then click **Create**.
4. **Data Access → Add or remove scopes**. Paste this into *Manually add scopes*, click **Add to table**, then **Update** and **Save**:
   ```
   https://www.googleapis.com/auth/gmail.modify, openid, https://www.googleapis.com/auth/userinfo.email, https://www.googleapis.com/auth/userinfo.profile
   ```
5. **Branding**: fill in the links and the domain, then **Save**:
   - Home page: `YOUR_URL`
   - Privacy policy: `YOUR_URL/privacy`
   - Terms of service: `YOUR_URL/terms`
   - Authorized domain: your `yourname.workers.dev` part (the address minus `multi-inbox.`)
6. **Audience → Publish app → Confirm**. This sets the app to *In production* while it stays unverified. You'll click through a "Google hasn't verified this app" warning once per inbox, but Google won't sign you out every 7 days the way it does in *Testing*. It allows up to 100 Google accounts.
7. **Clients → Create client** → *Web application*. Under **Authorized redirect URIs** add `YOUR_URL/callback/google`, then click **Create**.
8. A popup shows the **Client secret**. Google shows it **only once**, so keep the popup open. In Terminal:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Paste the secret and press Enter. Then do the same for the Client ID, which is also in the popup or on the Clients page:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
```

## 4. Microsoft (optional: Outlook / Hotmail / Microsoft 365)

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **App registrations → New registration**.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   - Redirect URI: **Web**, `YOUR_URL/callback/microsoft`
2. **Certificates & secrets → New client secret**. Copy its **Value**.
3. **API permissions → Add → Microsoft Graph → Delegated**: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`.
4. Store both values in the server:

```bash
npx wrangler secret put MICROSOFT_CLIENT_SECRET
```

```bash
npx wrangler secret put MICROSOFT_CLIENT_ID
```

The client ID is the *Application (client) ID* on the Overview page. The client secret expires after two years at most, so set a reminder to make a new one.

## 5. Add it to Claude

1. In Claude, go to **Settings → Connectors** (it may be called *Plugins*) → **Add → Add custom connector**.
2. Name: `Multi-Inbox`. URL: `YOUR_URL/mcp`. Click **Continue**. Claude should detect sign-in automatically. Keep the defaults and click **Add**.
3. On the Multi-Inbox page that opens, click **Continue with Gmail**, pick an account, and get past Google's "unverified app" warning (**Advanced → Go to …**). Make sure the email permission box is checked.
4. Click **+ Add Gmail** or **+ Add Outlook** for every other inbox, then **Done, return to Claude**.
5. Test it in a new chat: *"Brief me on unread email from the last day across all my inboxes."*

**Claude says it "couldn't reach" the server?** Your new address is probably still cached as "not found" somewhere. You can wait an hour and try again. Faster: rename the Worker to something you haven't used yet (Cloudflare dashboard → Workers → your worker → **Settings → General → Name**). Then update the four addresses in Google (branding links and redirect URI), and add the connector with the new address.

### Inboxes signed in somewhere else

If an inbox is signed in in a different browser or Chrome profile, open `YOUR_URL` in your main browser and click **Make a link** under *Add an inbox from another browser*. Then open that link in the other browser. It works for 30 minutes.

### Morning briefings (Claude Duet and others)

Connectors belong to your Claude account, so features like Duet's morning brief can use Multi-Inbox once it's switched on there. Switch off the built-in single-account Gmail connector in the same place, so the same emails don't show up twice.

---

## Everyday use

- **Add or remove inboxes, set nicknames:** at `YOUR_URL`. Nicknames let you say *"check my work inbox"*.
- **Sending:** off by default (drafts only). Turn on **Let Claude send email directly** at `YOUR_URL`. It takes effect immediately. If Claude doesn't see the `send_email` tool yet, go to Claude's connector settings → Multi-Inbox → **⋯ → Refresh tools list**.
- **"Needs reconnect":** that inbox's access expired or was revoked. Add it again at `YOUR_URL`.
- **Update to a newer version:** `git pull` then `npm run deploy`.

## Sharing your copy with friends

Your server can hold several people's accounts, and each person only sees their own inboxes. A friend can open `YOUR_URL`, link their inboxes, and add `YOUR_URL/mcp` to their Claude. Keep in mind:

- **They're trusting you.** You run the server and hold the encryption key, so share only with people who are comfortable with that. Otherwise send them this repo so they can run their own copy.
- **Google allows 100 accounts per unverified app, ever.** Every Gmail anyone links counts toward it.

## Testing locally (optional)

```bash
cp .dev.vars.example .dev.vars
```

Put the output of `npm run gen-secrets` into `.dev.vars` and add `ENABLE_MOCK_PROVIDER=true`. Then start the server:

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

`npm run e2e` connects like Claude does, links fake inboxes, and calls every tool. `npm test` checks the Gmail and Outlook code against sample responses. Never enable the mock provider on a real deploy.
