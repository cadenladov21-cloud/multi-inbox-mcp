// A fake mailbox provider for local testing and demos. Only active when ENABLE_MOCK_PROVIDER=true.
import { publicUrl } from "../env";
import type { MailClient, MailProvider, MessageFull, MessageSummary, ModifyAction } from "./types";

function fakeInbox(email: string): MessageFull[] {
  const now = Date.now();
  const tag = email.split("@")[0];
  const mk = (i: number, from: string, subject: string, body: string, unread: boolean, hoursAgo: number): MessageFull => ({
    id: `${tag}-m${i}`,
    threadId: `${tag}-t${i}`,
    from,
    to: email,
    subject,
    date: new Date(now - hoursAgo * 3600_000).toISOString(),
    snippet: body.slice(0, 90),
    unread,
    body,
    attachments: [],
  });
  return [
    mk(1, "Dana Lee <dana@example.com>", `Q4 planning for ${tag}`, "Can we move the planning sync to Thursday at 2pm? I need the numbers by Wednesday.", true, 2),
    mk(2, "Billing <billing@example.net>", "Your invoice is ready", "Invoice #4821 for $49.00 is due on Dec 1.", true, 9),
    mk(3, "Sam Ortiz <sam@example.org>", "Dinner Saturday?", "Are you free Saturday around 7? Thinking of the new ramen place.", false, 30),
  ];
}

class MockClient implements MailClient {
  private msgs: MessageFull[];
  constructor(private email: string) {
    this.msgs = fakeInbox(email);
  }
  private strip(m: MessageFull): MessageSummary {
    const { body: _b, attachments: _a, ...s } = m;
    return s;
  }
  async listInbox(o: { after?: Date; unreadOnly?: boolean; max: number }) {
    return this.msgs
      .filter((m) => (!o.after || new Date(m.date) >= o.after) && (!o.unreadOnly || m.unread))
      .slice(0, o.max)
      .map((m) => this.strip(m));
  }
  async search(o: { query?: string; from?: string; after?: Date; unreadOnly?: boolean; max: number }) {
    const q = (o.query ?? "").toLowerCase();
    return this.msgs
      .filter((m) => !q || (m.subject + m.body).toLowerCase().includes(q))
      .filter((m) => !o.from || m.from.toLowerCase().includes(o.from.toLowerCase()))
      .filter((m) => !o.unreadOnly || m.unread)
      .slice(0, o.max)
      .map((m) => this.strip(m));
  }
  async getMessage(id: string) {
    const m = this.msgs.find((x) => x.id === id);
    if (!m) throw new Error(`No message ${id}`);
    return m;
  }
  async getThread(threadId: string) {
    return this.msgs.filter((m) => m.threadId === threadId);
  }
  async createDraft() {
    return { id: `draft-${crypto.randomUUID()}` };
  }
  async send() {
    return { id: `sent-${crypto.randomUUID()}` };
  }
  async modify(_id: string, _a: ModifyAction) {}
}

export const mock: MailProvider = {
  id: "mock",
  label: "Test mailbox",
  isConfigured: (env) => env.ENABLE_MOCK_PROVIDER === "true",
  authorizeUrl(env, { state, redirectUri }) {
    return `${publicUrl(env)}/mock/authorize?${new URLSearchParams({ state, redirect_uri: redirectUri })}`;
  },
  async exchangeCode(_env, { code }) {
    const email = atob(code).toLowerCase();
    return { email, accessToken: `mock-access-${email}`, expiresIn: 3600, refreshToken: `mock-refresh-${email}` };
  },
  async refresh(_env, refreshToken) {
    return { accessToken: refreshToken.replace("refresh", "access"), expiresIn: 3600 };
  },
  client: (_token, email) => new MockClient(email),
};
