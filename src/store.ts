// User + linked-mailbox storage in Workers KV. Refresh/access tokens are encrypted at rest.
import { decrypt, encrypt, randomId } from "./crypto";
import type { Env } from "./env";
import { PROVIDERS } from "./providers";
import { ReconnectNeeded, type LinkedIdentity, type MailClient, type ProviderId } from "./providers/types";

export interface Account {
  id: string;
  provider: ProviderId;
  email: string;
  /** Optional nickname like "work" or "personal". */
  label?: string;
  name?: string;
  encRefreshToken: string;
  addedAt: string;
  needsReconnect?: boolean;
}

export interface User {
  id: string;
  createdAt: string;
  /** Lets Claude send mail directly (otherwise drafts only). Off by default. */
  allowSend: boolean;
  accounts: Account[];
}

const userKey = (id: string) => `user:${id}`;
const mailboxKey = (provider: string, email: string) => `mailbox:${provider}:${email.toLowerCase()}`;
const accessKey = (accountId: string) => `atok:${accountId}`;

export async function getUser(env: Env, id: string): Promise<User | null> {
  return env.DATA_KV.get<User>(userKey(id), "json");
}

export async function saveUser(env: Env, user: User): Promise<void> {
  await env.DATA_KV.put(userKey(user.id), JSON.stringify(user));
}

/**
 * Attach a freshly-authorized mailbox. If `currentUserId` is given, the mailbox joins that user;
 * otherwise we find the user who already owns this mailbox, or create a new one.
 */
export async function linkMailbox(
  env: Env,
  provider: ProviderId,
  identity: LinkedIdentity,
  currentUserId?: string,
): Promise<{ user: User; account: Account }> {
  const ownerId = await env.DATA_KV.get(mailboxKey(provider, identity.email));
  let user = currentUserId ? await getUser(env, currentUserId) : ownerId ? await getUser(env, ownerId) : null;
  if (!user) user = { id: randomId(), createdAt: new Date().toISOString(), allowSend: false, accounts: [] };

  // Mailbox moving from another user to this one: detach it there.
  if (ownerId && ownerId !== user.id) {
    const prev = await getUser(env, ownerId);
    if (prev) {
      prev.accounts = prev.accounts.filter((a) => !(a.provider === provider && a.email === identity.email));
      await saveUser(env, prev);
    }
  }

  const encRefreshToken = await encrypt(env.ENCRYPTION_KEY, identity.refreshToken!);
  let account = user.accounts.find((a) => a.provider === provider && a.email === identity.email);
  if (account) {
    account.encRefreshToken = encRefreshToken;
    account.needsReconnect = false;
    account.name = identity.name ?? account.name;
  } else {
    account = {
      id: randomId(),
      provider,
      email: identity.email,
      name: identity.name,
      encRefreshToken,
      addedAt: new Date().toISOString(),
    };
    user.accounts.push(account);
  }
  await saveUser(env, user);
  await env.DATA_KV.put(mailboxKey(provider, identity.email), user.id);
  await cacheAccessToken(env, account.id, identity.accessToken, identity.expiresIn);
  return { user, account };
}

export async function removeAccount(env: Env, user: User, accountId: string): Promise<void> {
  const account = user.accounts.find((a) => a.id === accountId);
  if (!account) return;
  user.accounts = user.accounts.filter((a) => a.id !== accountId);
  await saveUser(env, user);
  await env.DATA_KV.delete(mailboxKey(account.provider, account.email));
  await env.DATA_KV.delete(accessKey(account.id));
  try {
    const p = PROVIDERS[account.provider];
    await p.revoke?.(env, await decrypt(env.ENCRYPTION_KEY, account.encRefreshToken));
  } catch {
    // Best effort.
  }
}

async function cacheAccessToken(env: Env, accountId: string, token: string, expiresIn: number) {
  const ttl = Math.max(60, Math.floor(expiresIn) - 120);
  await env.DATA_KV.put(accessKey(accountId), await encrypt(env.ENCRYPTION_KEY, token), { expirationTtl: ttl });
}

/** A ready-to-use mail client for one account, refreshing its access token when needed. */
export async function clientFor(env: Env, user: User, account: Account): Promise<MailClient> {
  const provider = PROVIDERS[account.provider];
  if (!provider.isConfigured(env)) throw new Error(`${provider.label} isn't configured on this server.`);
  const cached = await env.DATA_KV.get(accessKey(account.id));
  if (cached) return provider.client(await decrypt(env.ENCRYPTION_KEY, cached), account.email);

  const refreshToken = await decrypt(env.ENCRYPTION_KEY, account.encRefreshToken);
  try {
    const t = await provider.refresh(env, refreshToken);
    await cacheAccessToken(env, account.id, t.accessToken, t.expiresIn);
    if (t.refreshToken && t.refreshToken !== refreshToken) {
      // Microsoft rotates refresh tokens: persist the new one.
      const fresh = (await getUser(env, user.id)) ?? user;
      const acc = fresh.accounts.find((a) => a.id === account.id);
      if (acc) {
        acc.encRefreshToken = await encrypt(env.ENCRYPTION_KEY, t.refreshToken);
        await saveUser(env, fresh);
      }
    }
    return provider.client(t.accessToken, account.email);
  } catch (e) {
    if (e instanceof ReconnectNeeded && !account.needsReconnect) {
      const fresh = (await getUser(env, user.id)) ?? user;
      const acc = fresh.accounts.find((a) => a.id === account.id);
      if (acc) {
        acc.needsReconnect = true;
        await saveUser(env, fresh);
      }
    }
    throw e;
  }
}
