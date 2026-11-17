// Checks the Gmail and Outlook adapters against canned API responses (no network).
import { afterEach, describe, expect, it, vi } from "vitest";
import { google } from "../src/providers/google";
import { microsoft } from "../src/providers/microsoft";
import { resolveAccounts } from "../src/mcp";
import type { User } from "../src/store";

type Call = { url: string; init: RequestInit };
function mockFetch(responder: (url: string, init: RequestInit) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const body = responder(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : 200 });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("Gmail", () => {
  const meta = (id: string, labels: string[]) => ({
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    snippet: "Hi there &amp; welcome",
    internalDate: "1763370000000",
    payload: {
      headers: [
        { name: "From", value: "Ann <ann@x.com>" },
        { name: "Subject", value: "Hello" },
      ],
    },
  });

  it("builds the digest query and parses summaries", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/messages?")) return { messages: [{ id: "a" }, { id: "b" }] };
      if (url.includes("/messages/a")) return meta("a", ["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
      return meta("b", ["INBOX", "STARRED"]);
    });
    const c = google.client("tok", "me@gmail.com");
    const after = new Date("2026-11-16T00:00:00Z");
    const res = await c.listInbox({ after, unreadOnly: true, skipPromotions: true, max: 10 });
    const q = new URL(calls[0].url).searchParams.get("q");
    expect(q).toBe(`in:inbox after:${after.getTime() / 1000} is:unread -category:promotions -category:social`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ id: "a", from: "Ann <ann@x.com>", subject: "Hello", unread: true, category: "personal", snippet: "Hi there & welcome" });
    expect(res[1]).toMatchObject({ unread: false, starred: true });
  });

  it("extracts the plain-text body and attachments from a multipart message", async () => {
    mockFetch(() => ({
      ...meta("m", ["INBOX"]),
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "a@x.com" }, { name: "To", value: "me@gmail.com" }, { name: "Subject", value: "Report" }],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64url("Plain body — café ✓") } },
              { mimeType: "text/html", body: { data: b64url("<p>HTML body</p>") } },
            ],
          },
          { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "att1", size: 20480 } },
        ],
      },
    }));
    const m = await google.client("tok", "me@gmail.com").getMessage("m");
    expect(m.body).toBe("Plain body — café ✓");
    expect(m.to).toBe("me@gmail.com");
    expect(m.attachments).toEqual([{ name: "report.pdf", size: 20480, mimeType: "application/pdf" }]);
  });

  it("falls back to HTML converted to text", async () => {
    mockFetch(() => ({
      ...meta("m", []),
      payload: { mimeType: "text/html", headers: [], body: { data: b64url("<style>x{}</style><p>Hi&nbsp;Bob</p><a href='https://x.com'>link</a>") } },
    }));
    const m = await google.client("tok", "me@gmail.com").getMessage("m");
    expect(m.body).toContain("Hi Bob");
    expect(m.body).not.toContain("x{}");
  });

  it("creates a threaded reply draft with the right headers", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/messages/orig")) {
        return {
          id: "orig",
          threadId: "thr",
          payload: {
            headers: [
              { name: "From", value: "Ann <ann@x.com>" },
              { name: "Subject", value: "Lunch?" },
              { name: "Message-ID", value: "<abc@x.com>" },
            ],
          },
        };
      }
      return { id: "d1", message: { id: "m1" } };
    });
    await google.client("tok", "me@gmail.com").createDraft({ body: "Sounds good — see you", replyToMessageId: "orig" });
    const post = calls.find((c) => c.url.endsWith("/drafts"))!;
    const { message } = JSON.parse(post.init.body as string);
    expect(message.threadId).toBe("thr");
    const mime = Buffer.from(message.raw, "base64url").toString("utf8");
    expect(mime).toContain("To: Ann <ann@x.com>");
    expect(mime).toContain("Subject: Re: Lunch?");
    expect(mime).toContain("In-Reply-To: <abc@x.com>");
    expect(mime).toContain("References: <abc@x.com>");
    const body = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Sounds good — see you");
  });

  it("maps actions to label changes", async () => {
    const calls = mockFetch(() => ({}));
    const c = google.client("tok", "me@gmail.com");
    await c.modify("m1", "archive");
    await c.modify("m1", "trash");
    expect(calls[0].url).toMatch(/\/messages\/m1\/modify$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ removeLabelIds: ["INBOX"] });
    expect(calls[1].url).toMatch(/\/messages\/m1\/trash$/);
  });
});

describe("Outlook", () => {
  const msg = {
    id: "o1",
    conversationId: "c1",
    subject: "Status",
    from: { emailAddress: { name: "Bo", address: "bo@corp.com" } },
    toRecipients: [{ emailAddress: { address: "me@corp.com" } }],
    receivedDateTime: "2026-11-17T08:00:00Z",
    bodyPreview: "All green",
    isRead: false,
    flag: { flagStatus: "flagged" },
    inferenceClassification: "focused",
  };

  it("lists the inbox with filter + orderby", async () => {
    const calls = mockFetch(() => ({ value: [msg] }));
    const after = new Date("2026-11-16T00:00:00Z");
    const res = await microsoft.client("tok", "me@corp.com").listInbox({ after, unreadOnly: true, max: 5 });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v1.0/me/mailFolders/inbox/messages");
    expect(u.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-11-16T00:00:00.000Z and isRead eq false");
    expect(u.searchParams.get("$orderby")).toBe("receivedDateTime desc");
    expect(res[0]).toMatchObject({ id: "o1", threadId: "c1", from: "Bo <bo@corp.com>", unread: true, starred: true, category: "focused" });
  });

  it("searches with KQL and filters unread client-side", async () => {
    const calls = mockFetch(() => ({ value: [msg, { ...msg, id: "o2", isRead: true }] }));
    const res = await microsoft.client("tok", "me@corp.com").search({ query: 'budget "q4"', from: "bo", unreadOnly: true, max: 5 });
    expect(new URL(calls[0].url).searchParams.get("$search")).toBe('"budget q4 from:bo"');
    expect(res.map((m) => m.id)).toEqual(["o1"]);
  });

  it("drafts a reply via createReply", async () => {
    const calls = mockFetch(() => ({ id: "d1", webLink: "https://outlook/d1" }));
    const d = await microsoft.client("tok", "me@corp.com").createDraft({ body: "Thanks!", replyToMessageId: "o1" });
    expect(calls[0].url).toMatch(/\/messages\/o1\/createReply$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ comment: "Thanks!", message: {} });
    expect(d.webLink).toBe("https://outlook/d1");
  });

  it("archives by moving to the archive folder", async () => {
    const calls = mockFetch(() => ({}));
    await microsoft.client("tok", "me@corp.com").modify("o1", "archive");
    expect(calls[0].url).toMatch(/\/messages\/o1\/move$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ destinationId: "archive" });
  });
});

describe("account selector", () => {
  const user: User = {
    id: "u",
    createdAt: "",
    allowSend: false,
    accounts: [
      { id: "1", provider: "google", email: "me@gmail.com", label: "Personal", encRefreshToken: "", addedAt: "" },
      { id: "2", provider: "microsoft", email: "me@corp.com", label: "work", encRefreshToken: "", addedAt: "" },
      { id: "3", provider: "google", email: "side@project.io", encRefreshToken: "", addedAt: "" },
    ],
  };
  const ids = (s?: string) => resolveAccounts(user, s).map((a) => a.id);
  it("resolves all / email / nickname / provider / partial", () => {
    expect(ids()).toEqual(["1", "2", "3"]);
    expect(ids("all")).toEqual(["1", "2", "3"]);
    expect(ids("ME@CORP.COM")).toEqual(["2"]);
    expect(ids("personal")).toEqual(["1"]);
    expect(ids("gmail")).toEqual(["1", "3"]);
    expect(ids("outlook")).toEqual(["2"]);
    expect(ids("project")).toEqual(["3"]);
    expect(ids("nothing")).toEqual([]);
  });
});

describe("secrets", () => {
  it("accepts a base64 key or a long passphrase, and rejects short ones", async () => {
    const { encrypt, decrypt } = await import("../src/crypto");
    const b64 = Buffer.alloc(32, 7).toString("base64");
    expect(await decrypt(b64, await encrypt(b64, "hello"))).toBe("hello");
    const phrase = "correct horse battery staple 2026";
    expect(await decrypt(phrase, await encrypt(phrase, "hi"))).toBe("hi");
    await expect(encrypt("short", "x")).rejects.toThrow(/too short/);
  });
  it("treats placeholders as unset", async () => {
    const { isSet } = await import("../src/providers/types");
    expect(isSet("none")).toBe(false);
    expect(isSet(" None ")).toBe(false);
    expect(isSet("")).toBe(false);
    expect(isSet("abc.apps.googleusercontent.com")).toBe(true);
  });
});
