import type { Env } from "../env";
import {
  clip,
  htmlToText,
  httpJson,
  ProviderHttpError,
  ReconnectNeeded,
  type ComposeOptions,
  type MailClient,
  type MailProvider,
  type MessageFull,
  type MessageSummary,
  type ModifyAction,
} from "./types";

const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0/me";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
].join(" ");

const SUMMARY_FIELDS =
  "id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,flag,inferenceClassification,hasAttachments,webLink";
const FULL_FIELDS = SUMMARY_FIELDS + ",body,ccRecipients,replyTo";

interface GAddress {
  emailAddress?: { name?: string; address?: string };
}
interface GMsg {
  id: string;
  conversationId: string;
  subject?: string;
  from?: GAddress;
  toRecipients?: GAddress[];
  ccRecipients?: GAddress[];
  replyTo?: GAddress[];
  receivedDateTime: string;
  bodyPreview?: string;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  inferenceClassification?: string;
  hasAttachments?: boolean;
  webLink?: string;
  body?: { contentType?: string; content?: string };
}

const fmt = (a?: GAddress) =>
  a?.emailAddress ? (a.emailAddress.name ? `${a.emailAddress.name} <${a.emailAddress.address}>` : a.emailAddress.address ?? "") : "";
const fmtList = (l?: GAddress[]) => (l ?? []).map(fmt).filter(Boolean).join(", ");
const recipients = (l?: string[]) => (l ?? []).map((address) => ({ emailAddress: { address: address.trim() } }));

function summarize(m: GMsg): MessageSummary {
  return {
    id: m.id,
    threadId: m.conversationId,
    from: fmt(m.from),
    to: fmtList(m.toRecipients) || undefined,
    subject: m.subject || "(no subject)",
    date: m.receivedDateTime,
    snippet: m.bodyPreview ?? "",
    unread: m.isRead === false,
    starred: m.flag?.flagStatus === "flagged",
    category: m.inferenceClassification,
    hasAttachments: m.hasAttachments,
    webLink: m.webLink,
  };
}

/** KQL inside $search="..." can't contain raw double quotes. */
const kql = (s: string) => s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();

class OutlookClient implements MailClient {
  constructor(private token: string) {}

  private req<T>(path: string, what: string, init: RequestInit = {}): Promise<T> {
    return httpJson<T>(GRAPH + path, {
      ...init,
      what: `Outlook ${what}`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Prefer: 'outlook.body-content-type="text"',
        ...(init.headers ?? {}),
      },
    });
  }

  async listInbox(o: { after?: Date; unreadOnly?: boolean; max: number }) {
    const filters = [
      `receivedDateTime ge ${(o.after ?? new Date(0)).toISOString()}`,
      o.unreadOnly ? "isRead eq false" : "",
    ].filter(Boolean);
    const p = new URLSearchParams({
      $top: String(Math.min(o.max, 50)),
      $select: SUMMARY_FIELDS,
      $filter: filters.join(" and "),
      $orderby: "receivedDateTime desc",
    });
    const r = await this.req<{ value: GMsg[] }>(`/mailFolders/inbox/messages?${p}`, "list inbox");
    return r.value.map(summarize);
  }

  async search(o: { query?: string; from?: string; after?: Date; unreadOnly?: boolean; max: number }) {
    const terms = [o.query ? kql(o.query) : "", o.from ? `from:${kql(o.from)}` : ""].filter(Boolean);
    if (!terms.length) {
      // No text to search: plain filtered listing across all folders.
      const filters = [`receivedDateTime ge ${(o.after ?? new Date(0)).toISOString()}`, o.unreadOnly ? "isRead eq false" : ""].filter(Boolean);
      const p = new URLSearchParams({
        $top: String(Math.min(o.max, 50)),
        $select: SUMMARY_FIELDS,
        $filter: filters.join(" and "),
        $orderby: "receivedDateTime desc",
      });
      return (await this.req<{ value: GMsg[] }>(`/messages?${p}`, "list")).value.map(summarize);
    }
    if (o.after) terms.push(`received>=${o.after.toISOString().slice(0, 10)}`);
    // $search can't be combined with $filter/$orderby, so unread filtering happens here.
    const p = new URLSearchParams({
      $search: `"${terms.join(" ")}"`,
      $top: String(Math.min(o.unreadOnly ? o.max * 3 : o.max, 50)),
      $select: SUMMARY_FIELDS,
    });
    const r = await this.req<{ value: GMsg[] }>(`/messages?${p}`, "search");
    return r.value
      .map(summarize)
      .filter((m) => !o.unreadOnly || m.unread)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, o.max);
  }

  private async toFull(m: GMsg): Promise<MessageFull> {
    let attachments: MessageFull["attachments"] = [];
    if (m.hasAttachments) {
      const a = await this.req<{ value: { name: string; size?: number; contentType?: string; isInline?: boolean }[] }>(
        `/messages/${encodeURIComponent(m.id)}/attachments?$select=name,size,contentType,isInline`,
        "list attachments",
      );
      attachments = a.value.filter((x) => !x.isInline).map((x) => ({ name: x.name, size: x.size, mimeType: x.contentType }));
    }
    const raw = m.body?.content ?? "";
    return {
      ...summarize(m),
      to: fmtList(m.toRecipients),
      cc: fmtList(m.ccRecipients) || undefined,
      replyTo: fmtList(m.replyTo) || undefined,
      body: clip(m.body?.contentType === "html" ? htmlToText(raw) : raw.trim()),
      attachments,
    };
  }

  async getMessage(id: string) {
    const m = await this.req<GMsg>(`/messages/${encodeURIComponent(id)}?$select=${FULL_FIELDS}`, "get message");
    return this.toFull(m);
  }

  async getThread(threadId: string) {
    const p = new URLSearchParams({
      $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
      $select: FULL_FIELDS,
      $top: "50",
    });
    const r = await this.req<{ value: GMsg[] }>(`/messages?${p}`, "get thread");
    const sorted = r.value.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
    return Promise.all(sorted.map((m) => this.toFull(m)));
  }

  private messageFields(o: ComposeOptions) {
    return {
      ...(o.subject ? { subject: o.subject } : {}),
      ...(o.to?.length ? { toRecipients: recipients(o.to) } : {}),
      ...(o.cc?.length ? { ccRecipients: recipients(o.cc) } : {}),
    };
  }

  async createDraft(o: ComposeOptions) {
    let draft: GMsg;
    if (o.replyToMessageId) {
      draft = await this.req<GMsg>(`/messages/${encodeURIComponent(o.replyToMessageId)}/createReply`, "create reply draft", {
        method: "POST",
        body: JSON.stringify({ comment: o.body, message: this.messageFields(o) }),
      });
    } else {
      if (!o.to?.length) throw new Error("Missing recipient: provide `to`.");
      draft = await this.req<GMsg>("/messages", "create draft", {
        method: "POST",
        body: JSON.stringify({ ...this.messageFields(o), subject: o.subject ?? "", body: { contentType: "Text", content: o.body } }),
      });
    }
    return { id: draft.id, webLink: draft.webLink };
  }

  async send(o: ComposeOptions) {
    if (o.replyToMessageId) {
      await this.req(`/messages/${encodeURIComponent(o.replyToMessageId)}/reply`, "send reply", {
        method: "POST",
        body: JSON.stringify({ comment: o.body, message: this.messageFields(o) }),
      });
      return {};
    }
    if (!o.to?.length) throw new Error("Missing recipient: provide `to`.");
    await this.req("/sendMail", "send", {
      method: "POST",
      body: JSON.stringify({
        message: { ...this.messageFields(o), subject: o.subject ?? "", body: { contentType: "Text", content: o.body } },
        saveToSentItems: true,
      }),
    });
    return {};
  }

  async modify(id: string, action: ModifyAction) {
    const path = `/messages/${encodeURIComponent(id)}`;
    const patch = (body: unknown) => this.req(path, action, { method: "PATCH", body: JSON.stringify(body) });
    const move = (destinationId: string) =>
      this.req(`${path}/move`, action, { method: "POST", body: JSON.stringify({ destinationId }) });
    switch (action) {
      case "archive":
        return void (await move("archive"));
      case "trash":
        return void (await move("deleteditems"));
      case "mark_read":
        return void (await patch({ isRead: true }));
      case "mark_unread":
        return void (await patch({ isRead: false }));
      case "star":
        return void (await patch({ flag: { flagStatus: "flagged" } }));
      case "unstar":
        return void (await patch({ flag: { flagStatus: "notFlagged" } }));
    }
  }
}

interface MsTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

function tokenRequest(env: Env, body: Record<string, string>, what: string) {
  return httpJson<MsTokenResponse>(`${AUTH}/token`, {
    what,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID!,
      client_secret: env.MICROSOFT_CLIENT_SECRET!,
      scope: SCOPES,
      ...body,
    }),
  });
}

export const microsoft: MailProvider = {
  id: "microsoft",
  label: "Outlook",
  isConfigured: (env) => Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET),

  authorizeUrl(env, { state, challenge, redirectUri }) {
    const p = new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID!,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    return `${AUTH}/authorize?${p}`;
  },

  async exchangeCode(env, { code, verifier, redirectUri }) {
    const t = await tokenRequest(
      env,
      { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier },
      "Microsoft token exchange",
    );
    if (!t.refresh_token) throw new Error("Microsoft did not return a refresh token (offline_access not granted).");
    const me = await httpJson<{ mail?: string; userPrincipalName?: string; displayName?: string }>(
      `${GRAPH}?$select=mail,userPrincipalName,displayName`,
      { what: "Microsoft profile", headers: { Authorization: `Bearer ${t.access_token}` } },
    );
    const email = (me.mail || me.userPrincipalName || "").toLowerCase();
    if (!email) throw new Error("Couldn't read the email address of this Microsoft account.");
    return { email, name: me.displayName, accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token };
  },

  async refresh(env, refreshToken) {
    try {
      const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken }, "Microsoft token refresh");
      return { accessToken: t.access_token, expiresIn: t.expires_in, refreshToken: t.refresh_token };
    } catch (e) {
      if (e instanceof ProviderHttpError && e.status === 400 && e.message.includes("invalid_grant")) {
        throw new ReconnectNeeded("Microsoft access expired or was revoked");
      }
      throw e;
    }
  },

  client: (token) => new OutlookClient(token),
};
