import type { Env } from "../env";

export type ProviderId = "google" | "microsoft" | "mock";

export interface TokenSet {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Present on first sign-in; Microsoft also rotates it on refresh. */
  refreshToken?: string;
}

export interface LinkedIdentity extends TokenSet {
  email: string;
  name?: string;
}

export interface MessageSummary {
  id: string;
  threadId: string;
  from: string;
  to?: string;
  subject: string;
  /** ISO 8601 */
  date: string;
  snippet: string;
  unread: boolean;
  starred?: boolean;
  /** e.g. Outlook "focused"/"other", Gmail category label. */
  category?: string;
  hasAttachments?: boolean;
  webLink?: string;
}

export interface MessageFull extends MessageSummary {
  to: string;
  cc?: string;
  replyTo?: string;
  body: string;
  attachments: { name: string; size?: number; mimeType?: string }[];
}

export interface ListOptions {
  /** Only messages received after this time. */
  after?: Date;
  unreadOnly?: boolean;
  /** Skip promotional/social mail where the provider can tell. */
  skipPromotions?: boolean;
  max: number;
}

export interface SearchOptions {
  query?: string;
  from?: string;
  after?: Date;
  unreadOnly?: boolean;
  max: number;
}

export interface ComposeOptions {
  to?: string[];
  cc?: string[];
  subject?: string;
  body: string;
  /** If set, the message is a reply in that message's thread. */
  replyToMessageId?: string;
}

export type ModifyAction = "archive" | "mark_read" | "mark_unread" | "star" | "unstar" | "trash";

export interface MailClient {
  listInbox(opts: ListOptions): Promise<MessageSummary[]>;
  search(opts: SearchOptions): Promise<MessageSummary[]>;
  getMessage(id: string): Promise<MessageFull>;
  getThread(threadId: string): Promise<MessageFull[]>;
  createDraft(opts: ComposeOptions): Promise<{ id: string; webLink?: string }>;
  send(opts: ComposeOptions): Promise<{ id?: string }>;
  modify(id: string, action: ModifyAction): Promise<void>;
}

export interface MailProvider {
  id: ProviderId;
  label: string;
  isConfigured(env: Env): boolean;
  authorizeUrl(env: Env, p: { state: string; challenge: string; redirectUri: string }): string;
  exchangeCode(env: Env, p: { code: string; verifier: string; redirectUri: string }): Promise<LinkedIdentity>;
  refresh(env: Env, refreshToken: string): Promise<TokenSet>;
  revoke?(env: Env, refreshToken: string): Promise<void>;
  client(accessToken: string, email: string): MailClient;
}

/** Thrown when a mailbox's refresh token no longer works (user revoked access, password change...). */
export class ReconnectNeeded extends Error {}

export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function httpJson<T>(url: string, init: RequestInit & { what: string }): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {}
    throw new ProviderHttpError(res.status, `${init.what} failed (${res.status}): ${detail}`);
  }
  if (res.status === 202 || res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Simple HTML → text for email bodies. Good enough for an LLM to read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return t && !href.startsWith("mailto:") && t !== href ? `${t} (${href})` : t || href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Keep tool output a sane size: very long bodies (newsletters) get cut. */
export function clip(text: string, max = 12000): string {
  return text.length > max ? text.slice(0, max) + `\n\n[…truncated ${text.length - max} characters]` : text;
}
