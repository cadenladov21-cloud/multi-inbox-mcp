// End-to-end test against `npm run dev` with ENABLE_MOCK_PROVIDER=true.
// Plays the part of Claude: registers, runs the OAuth connect flow (linking two test inboxes),
// exchanges the code for a token, then calls the MCP tools.
// Usage: npm run dev   (in one terminal)   then   npm run e2e
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const REDIRECT = "http://localhost:9999/callback";
const jar = new Map();
const RUN = randomBytes(3).toString("hex"); // unique inboxes per run, since local KV persists
const WORK = `work${RUN}@example.com`;
const PERSONAL = `personal${RUN}@example.com`;
const rx = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

function store(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1);
    if (attrs.some((a) => /max-age=0\b/i.test(a.trim())) || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}
async function req(path, init = {}) {
  const url = path.startsWith("http") ? path : BASE + path;
  const headers = new Headers(init.headers);
  if (url.startsWith(BASE) && jar.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  store(res);
  return res;
}
const loc = (res) => {
  assert.equal(res.status, 302, `expected redirect, got ${res.status}`);
  return res.headers.get("Location");
};
const step = (s) => console.log(`✓ ${s}`);

// 1. Discovery
let r = await req("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
assert.equal(r.status, 401);
assert.match(r.headers.get("WWW-Authenticate") ?? "", /resource_metadata=/);
step("unauthenticated /mcp → 401 with resource metadata pointer");
const prm = await (await req("/.well-known/oauth-protected-resource/mcp")).json();
assert.equal(prm.resource, `${BASE}/mcp`);
const asm = await (await req("/.well-known/oauth-authorization-server")).json();
assert.ok(asm.registration_endpoint && asm.token_endpoint && asm.authorization_endpoint);
step("discovery metadata OK");

// 2. Dynamic client registration
const client = await (
  await req(asm.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "E2E Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  })
).json();
assert.ok(client.client_id);
step("client registered");

// 3. Authorization with PKCE
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authUrl = new URL(asm.authorization_endpoint);
Object.entries({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "abc123",
  scope: "mail",
  resource: `${BASE}/mcp`,
}).forEach(([k, v]) => authUrl.searchParams.set(k, v));
r = await req(authUrl.toString());
assert.equal(r.status, 200);
let page = await r.text();
const handle = page.match(/name="handle" value="([^"]+)"/)[1];
assert.match(page, /Continue with Test mailbox/);
step("consent page rendered");

r = await req("/authorize", { method: "POST", body: new URLSearchParams({ handle, decision: "mock" }) });
let next = loc(r);
assert.match(next, /\/mock\/authorize/);
const linkMock = async (startUrl, email) => {
  const u = new URL(startUrl);
  const approve = `/mock/approve?${new URLSearchParams({ state: u.searchParams.get("state"), redirect_uri: u.searchParams.get("redirect_uri"), email })}`;
  const cb = loc(await req(approve)); // → /callback/mock?code&state
  const inboxes = loc(await req(cb)); // → /authorize/inboxes?state
  const res = await req(inboxes);
  assert.equal(res.status, 200);
  return res.text();
};
page = await linkMock(next, WORK);
assert.match(page, rx(WORK));
step("first inbox linked via Claude connect flow");

const addHref = page.match(/href="(\/authorize\/add\?provider=mock&amp;state=[^"]+)"/)[1].replace(/&amp;/g, "&");
next = loc(await req(addHref));
page = await linkMock(next, PERSONAL);
assert.match(page, rx(WORK));
assert.match(page, rx(PERSONAL));
step("second inbox linked in the same flow");

const doneHref = page.match(/href="(\/authorize\/done\?state=[^"]+)"/)[1];
const back = new URL(loc(await req(doneHref)));
assert.equal(back.origin + back.pathname, REDIRECT);
assert.equal(back.searchParams.get("state"), "abc123");
const code = back.searchParams.get("code");
assert.ok(code);
step("redirected back to Claude with an authorization code");

// 4. Token exchange
const tokenRes = await req(asm.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  }),
});
const tokens = await tokenRes.json();
assert.ok(tokens.access_token, JSON.stringify(tokens));
assert.ok(tokens.refresh_token);
step("code exchanged for access + refresh token");

// 5. MCP calls
let rpcId = 0;
async function rpc(method, params, token = tokens.access_token) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(res.status, 200, `${method}: HTTP ${res.status} ${await res.clone().text()}`);
  const body = await res.json();
  assert.ok(!body.error, `${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const call = async (name, args = {}) => {
  const out = await rpc("tools/call", { name, arguments: args });
  return { text: out.content.map((c) => c.text).join("\n"), isError: out.isError };
};

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
assert.equal(init.serverInfo.name, "multi-inbox");
assert.match(init.instructions, rx(WORK));
let tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
assert.deepEqual(tools.sort(), ["create_draft", "inbox_digest", "list_accounts", "read_email", "read_thread", "search_email", "send_email", "update_email"]);
let sendOut = await call("send_email", { account: WORK, to: ["x@example.com"], subject: "hi", body: "test" });
assert.ok(sendOut.isError);
assert.match(sendOut.text, /Sending is turned off/);
step(`initialize + tools/list (${tools.length} tools); send_email refuses while sending is off`);

let out = await call("list_accounts");
assert.match(out.text, rx(WORK));
assert.match(out.text, rx(PERSONAL));
out = await call("inbox_digest", {});
assert.match(out.text, rx(`## ${WORK}`));
assert.match(out.text, rx(`## ${PERSONAL}`));
assert.match(out.text, rx(`Q4 planning for work${RUN}`));
assert.doesNotMatch(out.text, /Dinner Saturday/); // older than 24h and already read
step("inbox_digest covers both inboxes");
console.log("\n--- sample inbox_digest output ---\n" + out.text.split("\n").slice(0, 12).join("\n") + "\n---\n");

out = await call("search_email", { query: "invoice", account: PERSONAL });
assert.match(out.text, /Your invoice is ready/);
assert.doesNotMatch(out.text, rx(WORK));
out = await call("read_email", { account: WORK, message_id: `work${RUN}-m1` });
assert.match(out.text, /Thursday at 2pm/);
out = await call("read_email", { account: "nope", message_id: "x" });
assert.ok(out.isError);
out = await call("create_draft", { account: WORK, to: ["dana@example.com"], subject: "Re: Q4", body: "Thursday works." });
assert.match(out.text, /Draft saved/);
out = await call("update_email", { account: PERSONAL, message_ids: [`personal${RUN}-m2`], action: "archive" });
assert.match(out.text, /archive: done for 1 message/);
step("search, read, draft, archive, and bad-account errors all behave");

// 6. Dashboard: nickname + enable sending (session cookie from the connect flow)
r = await req("/");
page = await r.text();
assert.match(page, /Linked inboxes/);
const workId = page.match(/name="id" value="([^"]+)">\s*<input type="text" name="label"/)[1];
loc(await req("/account/label", { method: "POST", headers: { Origin: BASE }, body: new URLSearchParams({ id: workId, label: "work" }) }));
loc(await req("/settings", { method: "POST", headers: { Origin: BASE }, body: new URLSearchParams({ allowSend: "1" }) }));
r = await req("/settings", { method: "POST", headers: { Origin: "https://evil.example" }, body: new URLSearchParams({ allowSend: "0" }) });
assert.equal(r.status, 403);
tools = (await rpc("tools/list", {})).tools.map((t) => t.name);
assert.ok(tools.includes("send_email"));
sendOut = await call("send_email", { account: WORK, to: ["x@example.com"], subject: "hi", body: "test" });
assert.ok(!sendOut.isError, sendOut.text);
assert.match(sendOut.text, /Sent from/);
out = await call("inbox_digest", { account: "work" });
assert.match(out.text, rx(`## work (${WORK}`));
assert.doesNotMatch(out.text, rx(PERSONAL));
step("dashboard: nickname works as account selector, send toggle enables sending, cross-site POST blocked");

// 6b. Add an inbox from another browser via a 30-minute link
const inviteLoc = loc(await req("/invite", { method: "POST", headers: { Origin: BASE }, body: new URLSearchParams() }));
page = await (await req(inviteLoc)).text();
const addUrl = page.match(/<code>(http[^<]*\/add\/[^<]+)<\/code>/)[1];
const mainJar = new Map(jar);
jar.clear(); // pretend to be a different browser: no cookies
assert.equal((await req("/add/not-a-real-token-123456789")).status, 410);
page = await (await req(addUrl)).text();
assert.match(page, /Add an inbox/);
const THIRD = `third${RUN}@example.com`;
next = loc(await req(`${addUrl}/mock`));
{
  const u = new URL(next);
  const approve = `/mock/approve?${new URLSearchParams({ state: u.searchParams.get("state"), redirect_uri: u.searchParams.get("redirect_uri"), email: THIRD })}`;
  const cb = loc(await req(approve));
  r = await req(cb);
  assert.equal(r.status, 200);
  assert.match(await r.text(), rx(`Added ${THIRD}`));
}
assert.ok(![...jar.keys()].includes("__Host-mi_session"), "invite flow must not sign the other browser in");
jar.clear();
mainJar.forEach((v, k) => jar.set(k, v));
out = await call("list_accounts");
assert.match(out.text, rx(THIRD));
step("another browser adds an inbox via a link, without getting dashboard access");

// 7. Refresh token
const refreshed = await (
  await req(asm.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }),
  })
).json();
assert.ok(refreshed.access_token);
await rpc("tools/list", {}, refreshed.access_token);
step("refresh token grant works");

console.log("\nAll end-to-end checks passed.");
