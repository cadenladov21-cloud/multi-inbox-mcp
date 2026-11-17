import type { Env } from "../env";
import { google } from "./google";
import { microsoft } from "./microsoft";
import { mock } from "./mock";
import type { MailProvider, ProviderId } from "./types";

export const PROVIDERS: Record<ProviderId, MailProvider> = { google, microsoft, mock };

export function enabledProviders(env: Env): MailProvider[] {
  return Object.values(PROVIDERS).filter((p) => p.isConfigured(env));
}

export function providerById(env: Env, id: string | null | undefined): MailProvider | null {
  if (!id || !(id in PROVIDERS)) return null;
  const p = PROVIDERS[id as ProviderId];
  return p.isConfigured(env) ? p : null;
}
