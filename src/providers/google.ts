import type { Env } from "../env";
import { buildMime, replySubject, toBase64Url } from "./mime";
import {
  clip,
  htmlToText,
  httpJson,
  ProviderHttpError,
  isSet,
  ReconnectNeeded,
  type ComposeOptions,
  type MailClient,
  type MailProvider,
  type MessageFull,
  type MessageSummary,
  type ModifyAction,
} from "./types";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GHeader {
  name: string;
  value: string;
}
interface GPart {
  mimeType?: string;
  filename?: string;
  headers?: GHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GPart[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GPart;
}

function header(msg: GMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBody(data: string): string {
  const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeEntities(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function summarize(msg: GMessage, email: string): MessageSummary {
  const labels = msg.labelIds ?? [];
  const cat = labels.find((l) => l.startsWith("CATEGORY_"));
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: header(msg, "From"),
    to: header(msg, "To") || undefined,
    subject: header(msg, "Subject") || "(no subject)",
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(msg, "Date"),
    snippet: decodeEntities(msg.snippet ?? ""),
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    category: cat ? cat.replace("CATEGORY_", "").toLowerCase() : undefined,
    webLink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${msg.threadId}`,
  };
}

function full(msg: GMessage, email: string): MessageFull {
  let plain = "";
  let html = "";
  const attachments: MessageFull["attachments"] = [];
  const walk = (p?: GPart) => {
    if (!p) return;
    if (p.filename && (p.body?.attachmentId || p.body?.size)) {
      attachments.push({ name: p.filename, size: p.body?.size, mimeType: p.mimeType });
    } else if (p.mimeType === "text/plain" && p.body?.data && !plain) {
      plain = decodeBody(p.body.data);
    } else if (p.mimeType === "text/html" && p.body?.data && !html) {
      html = decodeBody(p.body.data);
    }
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  const s = summarize(msg, email);
  return {
    ...s,
    to: header(msg, "To"),
    cc: header(msg, "Cc") || undefined,
    replyTo: header(msg, "Reply-To") || undefined,
    hasAttachments: attachments.length > 0,
    body: clip(plain.trim() ? plain.trim() : htmlToText(html)),
    attachments,
  };
}

function gmailDate(d: Date): string {
  return `after:${Math.floor(d.getTime() / 1000)}`;
}

class GmailClient implements MailClient {
  constructor(
    private token: string,
    private email: string,
  ) {}

  private req<T>(path: string, what: string, init: RequestInit = {}): Promise<T> {
    return httpJson<T>(API + path, {
      ...init,
      what: `Gmail ${what}`,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  }

  private async listByQuery(q: string, max: number): Promise<MessageSummary[]> {
    const params = new URLSearchParams({ q, maxResults: String(Math.min(max, 50)) });
    const res = await this.req<{ messages?: { id: string }[] }>(`/messages?${params}`, "list");
    const ids = (res.messages ?? []).map((m) => m.id);
    const meta = ["From", "To", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
    const msgs = await Promise.all(
      ids.map((id) => this.req<GMessage>(`/messages/${id}?format=metadata&${meta}`, "get message")),
    );
    return msgs.map((m) => summarize(m, this.email));
  }

  listInbox(o: { after?: Date; unreadOnly?: boolean; skipPromotions?: boolean; max: number }) {
    const q = [
      "in:inbox",
      o.after ? gmailDate(o.after) : "",
      o.unreadOnly ? "is:unread" : "",
      o.skipPromotions ? "-category:promotions -category:social" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return this.listByQuery(q, o.max);
  }

  search(o: { query?: string; from?: string; after?: Date; unreadOnly?: boolean; max: number }) {
    const q = [
      o.query ?? "",
      o.from ? `from:(${o.from})` : "",
      o.after ? gmailDate(o.after) : "",
      o.unreadOnly ? "is:unread" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return this.listByQuery(q || "in:inbox", o.max);
  }

  async getMessage(id: string) {
    return full(await this.req<GMessage>(`/messages/${encodeURIComponent(id)}?format=full`, "get message"), this.email);
  }

  async getThread(threadId: string) {
    const t = await this.req<{ messages?: GMessage[] }>(`/threads/${encodeURIComponent(threadId)}?format=full`, "get thread");
    return (t.messages ?? []).map((m) => full(m, this.email));
  }

  private async compose(o: ComposeOptions): Promise<{ raw: string; threadId?: string }> {
    let to = o.to ?? [];
    let subject = o.subject ?? "";
    let inReplyTo: string | undefined;
    let references: string | undefined;
    let threadId: string | undefined;
    if (o.replyToMessageId) {
      const meta = ["From", "Reply-To", "Subject", "Message-ID", "References"].map((h) => `metadataHeaders=${h}`).join("&");
      const orig = await this.req<GMessage>(
        `/messages/${encodeURIComponent(o.replyToMessageId)}?format=metadata&${meta}`,
        "get original message",
      );
      threadId = orig.threadId;
      inReplyTo = header(orig, "Message-ID") || undefined;
      references = [header(orig, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
      if (!to.length) to = [header(orig, "Reply-To") || header(orig, "From")].filter(Boolean);
      if (!subject) subject = replySubject(header(orig, "Subject"));
    }
    if (!to.length) throw new Error("Missing recipient: provide `to` (or reply_to_message_id).");
    const mime = buildMime({ to, cc: o.cc, subject: subject || "(no subject)", body: o.body, inReplyTo, references });
    return { raw: toBase64Url(mime), threadId };
  }

  async createDraft(o: ComposeOptions) {
    const message = await this.compose(o);
    const d = await this.req<{ id: string; message: { id: string } }>("/drafts", "create draft", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    return { id: d.id, webLink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(this.email)}#drafts` };
  }

  async send(o: ComposeOptions) {
    const message = await this.compose(o);
    const m = await this.req<{ id: string }>("/messages/send", "send", { method: "POST", body: JSON.stringify(message) });
    return { id: m.id };
  }

  async modify(id: string, action: ModifyAction) {
    const path = `/messages/${encodeURIComponent(id)}`;
    if (action === "trash") {
      await this.req(`${path}/trash`, "trash", { method: "POST" });
      return;
    }
    const change: Record<ModifyAction, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
      archive: { removeLabelIds: ["INBOX"] },
      mark_read: { removeLabelIds: ["UNREAD"] },
      mark_unread: { addLabelIds: ["UNREAD"] },
      star: { addLabelIds: ["STARRED"] },
      unstar: { removeLabelIds: ["STARRED"] },
      trash: {},
    };
    await this.req(`${path}/modify`, action, { method: "POST", body: JSON.stringify(change[action]) });
  }
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export const google: MailProvider = {
  id: "google",
  label: "Gmail",
  isConfigured: (env) => isSet(env.GOOGLE_CLIENT_ID) && isSet(env.GOOGLE_CLIENT_SECRET),

  authorizeUrl(env, { state, challenge, redirectUri }) {
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: `openid email profile ${GMAIL_SCOPE}`,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  },

  async exchangeCode(env, { code, verifier, redirectUri }) {
    const t = await httpJson<GoogleTokenResponse>("https://oauth2.googleapis.com/token", {
      what: "Google token exchange",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    if (!t.scope?.split(" ").includes(GMAIL_SCOPE)) {
      throw new Error(
        "Gmail access wasn't granted. On Google's permission screen, make sure the box for reading and managing your email is checked.",
      );
    }
    if (!t.refresh_token) throw new Error("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.");
    const info = await httpJson<{ email: string; name?: string }>("https://openidconnect.googleapis.com/v1/userinfo", {
      what: "Google userinfo",
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    return { email: info.email.toLowerCase(), name: info.name, accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token };
  },

  async refresh(env, refreshToken) {
    try {
      const t = await httpJson<GoogleTokenResponse>("https://oauth2.googleapis.com/token", {
        what: "Google token refresh",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
      return { accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token };
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 400 && e.message.includes("invalid_grant")) {
        throw new ReconnectNeeded("Google access expired or was revoked");
      }
      throw e;
    }
  },

  async revoke(_env, refreshToken) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: "POST" });
  },

  client: (token, email) => new GmailClient(token, email),
};
