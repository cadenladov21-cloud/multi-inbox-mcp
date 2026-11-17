// Everything that isn't the MCP endpoint: the Claude connect flow (/authorize), mailbox linking, and the dashboard.
import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { pkcePair, randomId, sign, verify } from "./crypto";
import { publicUrl, type Env } from "./env";
import {
  connectInboxesPage,
  consentPage,
  dashboardPage,
  errorPage,
  inviteDonePage,
  invitePage,
  mockAuthorizePage,
  privacyPage,
  signInPage,
  termsPage,
} from "./html";
import { enabledProviders, providerById } from "./providers";
import type { MailProvider, ProviderId } from "./providers/types";
import { getUser, linkMailbox, removeAccount, saveUser, type User } from "./store";

const SESSION_COOKIE = "__Host-mi_session";
const LINK_COOKIE = "__Host-mi_link";
const SESSION_DAYS = 30;

/** Data we carry through the library's upstream transactions during the Claude connect flow. */
type FlowData =
  | { kind: "provider"; provider: ProviderId; verifier: string; userId?: string }
  | { kind: "hold"; userId: string };

// ---------- small helpers ----------

const html = (body: string, status = 200, headers = new Headers()) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return new Response(body, { status, headers });
};

const redirect = (location: string, headers = new Headers()) => {
  headers.set("Location", location);
  return new Response(null, { status: 302, headers });
};

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie") ?? "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function sessionCookie(env: Env, userId: string) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  return cookie(SESSION_COOKIE, await sign(env.SESSION_SECRET, `${userId}|${exp}`), SESSION_DAYS * 86400);
}

async function sessionUser(env: Env, req: Request): Promise<User | null> {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return null;
  const value = await verify(env.SESSION_SECRET, raw);
  if (!value) return null;
  const [userId, exp] = value.split("|");
  if (!userId || Number(exp) < Date.now()) return null;
  return getUser(env, userId);
}

const callbackUrl = (env: Env, p: MailProvider) => `${publicUrl(env)}/callback/${p.id}`;

function sameOrigin(env: Env, req: Request): boolean {
  const origin = req.headers.get("Origin");
  return !origin || origin === new URL(publicUrl(env)).origin;
}

/** Park the approved Claude authorization request (between steps) and get a fresh state for it. */
async function hold(env: Env, authReq: AuthRequest, userId: string, headers: Headers) {
  const { state } = await env.OAUTH_PROVIDER.beginUpstream(authReq, { data: { kind: "hold", userId } satisfies FlowData, headers });
  return state;
}

// ---------- Claude connect flow ----------

async function authorizeGet(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authReq = await oauth.parseAuthRequest(req);
  const details = await oauth.describeConsent(authReq);
  const consent = await oauth.beginConsent(authReq);
  const user = await sessionUser(env, req);
  return html(consentPage(details, consent.handle, user, enabledProviders(env)), 200, consent.headers);
}

async function authorizePost(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await req.formData();
  const handle = String(form.get("handle") ?? "");
  const decision = String(form.get("decision") ?? "");

  if (decision === "deny") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const user = await sessionUser(env, req);
  if (decision === "existing") {
    if (!user?.accounts.length) return html(errorPage("Your session expired. Go back to Claude and connect again."), 400);
    const approved = await oauth.approveConsent(req, handle);
    const state = await hold(env, approved.request, user.id, approved.headers);
    return redirect(`/authorize/inboxes?state=${encodeURIComponent(state)}`, approved.headers);
  }

  const provider = providerById(env, decision);
  if (!provider) return html(errorPage("Unknown email provider."), 400);
  const approved = await oauth.approveConsent(req, handle);
  const { verifier, challenge } = await pkcePair();
  const data: FlowData = { kind: "provider", provider: provider.id, verifier, userId: user?.id };
  const { state } = await oauth.beginUpstream(approved.request, { data, headers: approved.headers });
  return redirect(provider.authorizeUrl(env, { state, challenge, redirectUri: callbackUrl(env, provider) }), approved.headers);
}

/** Shows linked inboxes mid-connect, with "add another" and "done". */
async function authorizeInboxes(req: Request, env: Env): Promise<Response> {
  const { request: authReq, data, headers } = await env.OAUTH_PROVIDER.finishUpstream<FlowData>(req);
  if (data.kind !== "hold") return html(errorPage("Unexpected step. Go back to Claude and connect again."), 400);
  const user = await getUser(env, data.userId);
  if (!user) return html(errorPage("Account not found. Go back to Claude and connect again."), 400);
  const state = await hold(env, authReq, user.id, headers);
  return html(connectInboxesPage(user, enabledProviders(env), state), 200, headers);
}

async function authorizeAdd(req: Request, env: Env, url: URL): Promise<Response> {
  const { request: authReq, data, headers } = await env.OAUTH_PROVIDER.finishUpstream<FlowData>(req);
  if (data.kind !== "hold") return html(errorPage("Unexpected step."), 400);
  const provider = providerById(env, url.searchParams.get("provider"));
  if (!provider) return html(errorPage("Unknown email provider."), 400);
  const { verifier, challenge } = await pkcePair();
  const next: FlowData = { kind: "provider", provider: provider.id, verifier, userId: data.userId };
  const { state } = await env.OAUTH_PROVIDER.beginUpstream(authReq, { data: next, headers });
  return redirect(provider.authorizeUrl(env, { state, challenge, redirectUri: callbackUrl(env, provider) }), headers);
}

async function authorizeDone(req: Request, env: Env): Promise<Response> {
  const { request: authReq, data, headers } = await env.OAUTH_PROVIDER.finishUpstream<FlowData>(req);
  if (data.kind !== "hold") return html(errorPage("Unexpected step."), 400);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: data.userId,
    metadata: {},
    scope: authReq.scope,
    props: { userId: data.userId },
  });
  return redirect(redirectTo, headers);
}

async function connectCallback(req: Request, env: Env, url: URL, provider: MailProvider): Promise<Response> {
  const { request: authReq, data, headers } = await env.OAUTH_PROVIDER.finishUpstream<FlowData>(req);
  if (data.kind !== "provider" || data.provider !== provider.id) return html(errorPage("Unexpected step."), 400);

  if (url.searchParams.get("error")) {
    // Declined at the provider. If they already have inboxes, go back to the list; otherwise tell Claude "denied".
    if (data.userId && (await getUser(env, data.userId))?.accounts.length) {
      const state = await hold(env, authReq, data.userId, headers);
      return redirect(`/authorize/inboxes?state=${encodeURIComponent(state)}`, headers);
    }
    return redirect(authorizationErrorRedirect(authReq, "access_denied"), headers);
  }

  const identity = await provider.exchangeCode(env, {
    code: url.searchParams.get("code") ?? "",
    verifier: data.verifier,
    redirectUri: callbackUrl(env, provider),
  });
  const { user } = await linkMailbox(env, provider.id, identity, data.userId);
  headers.append("Set-Cookie", await sessionCookie(env, user.id));
  const state = await hold(env, authReq, user.id, headers);
  return redirect(`/authorize/inboxes?state=${encodeURIComponent(state)}`, headers);
}

// ---------- Dashboard mailbox linking (outside the Claude flow) ----------

interface LinkState {
  provider: ProviderId;
  verifier: string;
  userId?: string;
  /** Started from an "add from another browser" link: attach to userId but don't sign this browser in. */
  viaInvite?: boolean;
}

const INVITE_TTL = 30 * 60;

/** A short-lived link that lets another browser add inboxes to this user (without dashboard access). */
async function createInvite(env: Env, userId: string): Promise<string> {
  const token = randomId(24);
  await env.DATA_KV.put(`invite:${token}`, userId, { expirationTtl: INVITE_TTL });
  return token;
}

async function inviteUser(env: Env, token: string): Promise<User | null> {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const userId = await env.DATA_KV.get(`invite:${token}`);
  return userId ? getUser(env, userId) : null;
}

async function dashboardConnect(req: Request, env: Env, provider: MailProvider, inviteFor?: User): Promise<Response> {
  const user = inviteFor ?? (await sessionUser(env, req));
  const { verifier, challenge } = await pkcePair();
  const state = `l.${randomId(24)}`;
  const saved: LinkState = { provider: provider.id, verifier, userId: user?.id, viaInvite: Boolean(inviteFor) };
  await env.DATA_KV.put(`link:${state}`, JSON.stringify(saved), {
    expirationTtl: 600,
  });
  const headers = new Headers({ "Set-Cookie": cookie(LINK_COOKIE, state, 600) });
  return redirect(provider.authorizeUrl(env, { state, challenge, redirectUri: callbackUrl(env, provider) }), headers);
}

async function dashboardCallback(req: Request, env: Env, url: URL, provider: MailProvider, state: string): Promise<Response> {
  if (readCookie(req, LINK_COOKIE) !== state) return html(errorPage("This sign-in was started in another browser. Please try again."), 400);
  const saved = await env.DATA_KV.get<LinkState>(`link:${state}`, "json");
  await env.DATA_KV.delete(`link:${state}`);
  if (!saved || saved.provider !== provider.id) return html(errorPage("This sign-in link expired. Please try again."), 400);
  const headers = new Headers({ "Set-Cookie": cookie(LINK_COOKIE, "", 0) });
  if (url.searchParams.get("error")) return redirect("/", headers);

  const identity = await provider.exchangeCode(env, {
    code: url.searchParams.get("code") ?? "",
    verifier: saved.verifier,
    redirectUri: callbackUrl(env, provider),
  });
  const { user } = await linkMailbox(env, provider.id, identity, saved.userId);
  if (saved.viaInvite) return html(inviteDonePage(identity.email, user.accounts.length), 200, headers);
  headers.append("Set-Cookie", await sessionCookie(env, user.id));
  return redirect(`/?linked=${encodeURIComponent(identity.email)}`, headers);
}

async function dashboardPost(req: Request, env: Env, path: string): Promise<Response> {
  if (!sameOrigin(env, req)) return new Response("Bad origin", { status: 403 });
  if (path === "/logout") return redirect("/", new Headers({ "Set-Cookie": cookie(SESSION_COOKIE, "", 0) }));
  const user = await sessionUser(env, req);
  if (!user) return redirect("/");
  const form = await req.formData();
  if (path === "/account/remove") {
    await removeAccount(env, user, String(form.get("id")));
  } else if (path === "/account/label") {
    const acc = user.accounts.find((a) => a.id === String(form.get("id")));
    const label = String(form.get("label") ?? "").trim().slice(0, 40);
    if (acc) {
      acc.label = label || undefined;
      await saveUser(env, user);
    }
  } else if (path === "/settings") {
    user.allowSend = form.get("allowSend") === "1";
    await saveUser(env, user);
  } else if (path === "/invite") {
    return redirect(`/?invite=${await createInvite(env, user.id)}`);
  }
  return redirect("/?saved=1");
}

// ---------- router ----------

export const webHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === "/authorize") return req.method === "POST" ? await authorizePost(req, env) : await authorizeGet(req, env);
      if (path === "/authorize/inboxes") return await authorizeInboxes(req, env);
      if (path === "/authorize/add") return await authorizeAdd(req, env, url);
      if (path === "/authorize/done") return await authorizeDone(req, env);

      const cb = path.match(/^\/callback\/(\w+)$/);
      if (cb) {
        const provider = providerById(env, cb[1]);
        if (!provider) return html(errorPage("Unknown email provider."), 404);
        const state = url.searchParams.get("state") ?? "";
        return state.startsWith("l.")
          ? await dashboardCallback(req, env, url, provider, state)
          : await connectCallback(req, env, url, provider);
      }

      const connect = path.match(/^\/connect\/(\w+)$/);
      if (connect) {
        const provider = providerById(env, connect[1]);
        if (!provider) return html(errorPage("Unknown email provider."), 404);
        return await dashboardConnect(req, env, provider);
      }

      if (req.method === "POST" && ["/logout", "/account/remove", "/account/label", "/settings", "/invite"].includes(path)) {
        return await dashboardPost(req, env, path);
      }

      // Add an inbox from another browser: /add/<token> and /add/<token>/<provider>
      const add = path.match(/^\/add\/([\w-]+)(?:\/(\w+))?$/);
      if (add) {
        const owner = await inviteUser(env, add[1]);
        if (!owner) return html(errorPage("This link expired. Make a new one from the Multi-Inbox home page."), 410);
        if (!add[2]) return html(invitePage(owner, enabledProviders(env), add[1]));
        const provider = providerById(env, add[2]);
        if (!provider) return html(errorPage("Unknown email provider."), 404);
        return await dashboardConnect(req, env, provider, owner);
      }

      if (path === "/" && req.method === "GET") {
        const user = await sessionUser(env, req);
        const linked = url.searchParams.get("linked");
        const flash = linked ? `Linked ${linked}.` : url.searchParams.get("saved") ? "Saved." : undefined;
        const invite = url.searchParams.get("invite");
        const inviteUrl = user && invite && (await inviteUser(env, invite))?.id === user.id ? `${publicUrl(env)}/add/${invite}` : undefined;
        return user
          ? html(dashboardPage(user, enabledProviders(env), `${publicUrl(env)}/mcp`, flash, inviteUrl))
          : html(signInPage(enabledProviders(env)));
      }

      if (env.ENABLE_MOCK_PROVIDER === "true") {
        if (path === "/mock/authorize") {
          return html(mockAuthorizePage(url.searchParams.get("state") ?? "", url.searchParams.get("redirect_uri") ?? ""));
        }
        if (path === "/mock/approve") {
          const target = url.searchParams.get("redirect_uri") ?? "";
          if (!target.startsWith(`${publicUrl(env)}/callback/`)) return new Response("bad redirect", { status: 400 });
          const back = new URL(target);
          back.searchParams.set("code", btoa(url.searchParams.get("email") ?? "test@example.com"));
          back.searchParams.set("state", url.searchParams.get("state") ?? "");
          return redirect(back.toString());
        }
      }

      if (path === "/privacy") return html(privacyPage());
      if (path === "/terms") return html(termsPage());
      if (path === "/favicon.ico") return new Response(null, { status: 204 });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return redirect(e.redirectTo);
      if (e instanceof AuthorizationError) {
        return html(errorPage(`${e.description}. Go back to Claude and try connecting again.`), 400);
      }
      if (e instanceof CimdFetchError) return html(errorPage("This app could not be verified."), 400);
      console.error("request failed", path, e);
      return html(errorPage(e instanceof Error ? e.message : "Unexpected error."), 500);
    }
  },
};
