import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** Public origin, no trailing slash. Optional: defaults to the address the request came in on. */
  PUBLIC_URL: string;
  /** "true" enables a fake mailbox provider for local testing. Never enable in production. */
  ENABLE_MOCK_PROVIDER?: string;

  /** Base64 of 32 random bytes. Encrypts mailbox tokens at rest. */
  ENCRYPTION_KEY: string;
  /** Random string (32+ chars). Signs the dashboard session cookie. */
  SESSION_SECRET: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;

  OAUTH_KV: KVNamespace;
  DATA_KV: KVNamespace;

  /** Injected by OAuthProvider for the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** What we store inside each Claude access token. */
export interface AuthProps {
  userId: string;
}

export function publicUrl(env: Env): string {
  return env.PUBLIC_URL.replace(/\/+$/, "");
}
