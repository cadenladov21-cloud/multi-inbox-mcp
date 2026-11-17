// The MCP endpoint: the tools Claude sees. Built fresh per request (stateless), scoped to one user.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { publicUrl, type AuthProps, type Env } from "./env";
import { PROVIDERS } from "./providers";
import { ReconnectNeeded, type MailClient, type MessageFull, type MessageSummary } from "./providers/types";
import { clientFor, getUser, type Account, type User } from "./store";

const VERSION = "0.1.0";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

const providerName = (a: Account) => PROVIDERS[a.provider]?.label ?? a.provider;
const accountName = (a: Account) => (a.label ? `${a.label} (${a.email}, ${providerName(a)})` : `${a.email} (${providerName(a)})`);

function describeAccounts(user: User): string {
  if (!user.accounts.length) return "No inboxes are linked yet.";
  return "Linked inboxes: " + user.accounts.map((a) => (a.label ? `"${a.label}" = ${a.email}` : a.email)).join("; ") + ".";
}

/** Resolve the `account` argument: "all", an email, a nickname, a provider ("gmail"/"outlook"), or part of an email. */
export function resolveAccounts(user: User, selector: string | undefined): Account[] {
  const s = (selector ?? "all").trim().toLowerCase();
  if (!s || s === "all" || s === "*") return user.accounts;
  const exact = user.accounts.filter((a) => a.email === s || a.label?.toLowerCase() === s);
  if (exact.length) return exact;
  const byProvider = user.accounts.filter(
    (a) => (s === "gmail" && a.provider === "google") || (s === "outlook" && a.provider === "microsoft"),
  );
  if (byProvider.length) return byProvider;
  return user.accounts.filter((a) => a.email.includes(s));
}

function oneAccount(user: User, selector: string): Account {
  const found = resolveAccounts(user, selector);
  if (found.length === 1) return found[0];
  const options = user.accounts.map((a) => a.label || a.email).join(", ");
  if (!found.length) throw new Error(`No linked inbox matches "${selector}". Options: ${options || "(none linked)"}.`);
  throw new Error(`"${selector}" matches several inboxes; use the exact email address. Options: ${options}.`);
}

function errorText(env: Env, e: unknown): string {
  if (e instanceof ReconnectNeeded) return `Access to this inbox expired. Re-add it at ${publicUrl(env)}`;
  return e instanceof Error ? e.message : String(e);
}

async function withClient<T>(env: Env, user: User, acc: Account, fn: (c: MailClient) => Promise<T>): Promise<T> {
  return fn(await clientFor(env, user, acc));
}

function fmtSummary(m: MessageSummary): string {
  const flags = [m.unread ? "UNREAD" : "", m.starred ? "starred" : "", m.hasAttachments ? "attachment" : "", m.category ? m.category : ""]
    .filter(Boolean)
    .join(", ");
  return [
    `- ${flags ? `[${flags}] ` : ""}${m.date} | From: ${m.from} | Subject: ${m.subject}`,
    `  message_id: ${m.id} | thread_id: ${m.threadId}`,
    m.snippet ? `  > ${m.snippet.replace(/\s+/g, " ").slice(0, 220)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function fmtFull(m: MessageFull): string {
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    m.cc ? `Cc: ${m.cc}` : "",
    m.replyTo ? `Reply-To: ${m.replyTo}` : "",
    `Date: ${m.date}`,
    `Subject: ${m.subject}`,
    `message_id: ${m.id} | thread_id: ${m.threadId}${m.unread ? " | UNREAD" : ""}`,
    m.webLink ? `Open: ${m.webLink}` : "",
    m.attachments.length ? `Attachments: ${m.attachments.map((a) => `${a.name}${a.size ? ` (${Math.round(a.size / 1024)} KB)` : ""}`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n") + `\n\n${m.body || "(empty body)"}`;
}

/** Run the same read on several inboxes in parallel, reporting per-inbox failures without failing the whole call. */
async function fanOut(
  env: Env,
  user: User,
  accounts: Account[],
  fn: (c: MailClient) => Promise<MessageSummary[]>,
): Promise<string> {
  const results = await Promise.all(
    accounts.map(async (acc) => {
      try {
        return { acc, msgs: await withClient(env, user, acc, fn) };
      } catch (e) {
        return { acc, error: errorText(env, e) };
      }
    }),
  );
  return results
    .map((r) =>
      r.error
        ? `## ${accountName(r.acc)}\nERROR: ${r.error}`
        : `## ${accountName(r.acc)} | ${r.msgs!.length} message${r.msgs!.length === 1 ? "" : "s"}\n` +
          (r.msgs!.length ? r.msgs!.map(fmtSummary).join("\n") : "(nothing matching)"),
    )
    .join("\n\n");
}

export function buildServer(env: Env, user: User): McpServer {
  const server = new McpServer(
    { name: "multi-inbox", version: VERSION },
    {
      instructions:
        "Access to ALL of the user's email inboxes (several Gmail and Outlook accounts) through one connector. " +
        "For briefings or 'what's new', call inbox_digest once; it covers every inbox. " +
        "Always say which inbox each email came from. Message and thread IDs are specific to their inbox, so pass the same `account` back when reading or acting on a message. " +
        describeAccounts(user),
    },
  );

  const noInboxes = () => text(`No inboxes are linked yet. Add one at ${publicUrl(env)}`);
  const accountArg = z
    .string()
    .optional()
    .describe(`Which inbox: "all" (default), an email address, or a nickname. ${describeAccounts(user)}`);
  const singleAccountArg = z
    .string()
    .describe(`The inbox the message belongs to: email address or nickname. ${describeAccounts(user)}`);

  server.registerTool(
    "list_accounts",
    {
      title: "List linked inboxes",
      description: "List every email inbox linked to this connector, with nicknames and status.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!user.accounts.length) return noInboxes();
      const lines = user.accounts.map(
        (a) => `- ${a.email} | ${providerName(a)}${a.label ? ` | nickname: ${a.label}` : ""}${a.needsReconnect ? " | NEEDS RECONNECT" : ""}`,
      );
      return text(
        `${lines.join("\n")}\n\nSending: ${user.allowSend ? "enabled" : "disabled (drafts only)"}.\nManage inboxes at ${publicUrl(env)}`,
      );
    },
  );

  server.registerTool(
    "inbox_digest",
    {
      title: "Recent mail across all inboxes",
      description:
        "Recent inbox messages from every linked inbox at once, grouped by inbox. Use this for morning briefings, 'catch me up on email', or 'anything important today?'. " +
        "Defaults: last 24 hours, unread only, promotions/social skipped (Gmail).",
      inputSchema: {
        hours: z.number().int().min(1).max(336).default(24).describe("How far back to look, in hours."),
        unread_only: z.boolean().default(true),
        skip_promotions: z.boolean().default(true).describe("Skip Gmail Promotions/Social tabs."),
        max_per_account: z.number().int().min(1).max(50).default(15),
        account: accountArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hours, unread_only, skip_promotions, max_per_account, account }) => {
      if (!user.accounts.length) return noInboxes();
      const accounts = resolveAccounts(user, account);
      if (!accounts.length) return fail(`No inbox matches "${account}". ${describeAccounts(user)}`);
      const after = new Date(Date.now() - hours * 3600_000);
      const body = await fanOut(env, user, accounts, (c) =>
        c.listInbox({ after, unreadOnly: unread_only, skipPromotions: skip_promotions, max: max_per_account }),
      );
      return text(`Inbox digest: last ${hours}h${unread_only ? ", unread only" : ""}. Times are UTC.\n\n${body}`);
    },
  );

  server.registerTool(
    "search_email",
    {
      title: "Search email",
      description:
        "Search one or all inboxes. `query` is free text; Gmail inboxes also accept Gmail operators (subject:, has:attachment, label:...), Outlook inboxes accept keywords like subject: and from:.",
      inputSchema: {
        query: z.string().optional().describe("Words to search for."),
        from: z.string().optional().describe("Sender name or address."),
        newer_than_days: z.number().int().min(1).max(3650).optional(),
        unread_only: z.boolean().default(false),
        max_results: z.number().int().min(1).max(50).default(10).describe("Per inbox."),
        account: accountArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, from, newer_than_days, unread_only, max_results, account }) => {
      if (!user.accounts.length) return noInboxes();
      const accounts = resolveAccounts(user, account);
      if (!accounts.length) return fail(`No inbox matches "${account}". ${describeAccounts(user)}`);
      const after = newer_than_days ? new Date(Date.now() - newer_than_days * 86400_000) : undefined;
      return text(await fanOut(env, user, accounts, (c) => c.search({ query, from, after, unreadOnly: unread_only, max: max_results })));
    },
  );

  server.registerTool(
    "read_email",
    {
      title: "Read an email",
      description: "Read the full content of one message (body, recipients, attachment names).",
      inputSchema: { account: singleAccountArg, message_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ account, message_id }) => {
      try {
        const acc = oneAccount(user, account);
        const m = await withClient(env, user, acc, (c) => c.getMessage(message_id));
        return text(`Inbox: ${accountName(acc)}\n${fmtFull(m)}`);
      } catch (e) {
        return fail(errorText(env, e));
      }
    },
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read a conversation",
      description: "Read every message in a conversation thread, oldest first.",
      inputSchema: { account: singleAccountArg, thread_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ account, thread_id }) => {
      try {
        const acc = oneAccount(user, account);
        const msgs = await withClient(env, user, acc, (c) => c.getThread(thread_id));
        if (!msgs.length) return fail("Thread not found or empty.");
        return text(`Inbox: ${accountName(acc)} | ${msgs.length} messages\n\n` + msgs.map(fmtFull).join("\n\n────────\n\n"));
      } catch (e) {
        return fail(errorText(env, e));
      }
    },
  );

  const composeShape = {
    account: singleAccountArg.describe(`Inbox to write from. ${describeAccounts(user)}`),
    to: z.array(z.string()).optional().describe("Recipient addresses. Optional when replying (defaults to the original sender)."),
    cc: z.array(z.string()).optional(),
    subject: z.string().optional().describe("Optional when replying (defaults to 'Re: …')."),
    body: z.string().describe("Plain-text body."),
    reply_to_message_id: z.string().optional().describe("Reply within this message's thread."),
  };

  server.registerTool(
    "create_draft",
    {
      title: "Create a draft",
      description: "Create a draft (new email or reply) in a specific inbox for the user to review and send. Nothing is sent.",
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ account, to, cc, subject, body, reply_to_message_id }) => {
      try {
        const acc = oneAccount(user, account);
        const d = await withClient(env, user, acc, (c) =>
          c.createDraft({ to, cc, subject, body, replyToMessageId: reply_to_message_id }),
        );
        return text(`Draft saved in ${accountName(acc)}.${d.webLink ? ` Review it: ${d.webLink}` : ""}`);
      } catch (e) {
        return fail(errorText(env, e));
      }
    },
  );

  // Always listed (clients cache tool lists), but only works while the user has sending switched on.
  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description:
        "Send an email (or reply) from a specific inbox immediately. Only use when the user has clearly asked to send; prefer create_draft otherwise. " +
        "Always show the user the recipients, subject and body and get their explicit confirmation before calling this. " +
        (user.allowSend ? "Sending is currently enabled." : "Sending is currently DISABLED by the user; use create_draft instead."),
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, to, cc, subject, body, reply_to_message_id }) => {
      if (!user.allowSend) {
        return fail(
          `Sending is turned off for this account, so nothing was sent. Use create_draft instead, or the user can turn on "Let Claude send email directly" at ${publicUrl(env)}`,
        );
      }
      try {
        const acc = oneAccount(user, account);
        await withClient(env, user, acc, (c) => c.send({ to, cc, subject, body, replyToMessageId: reply_to_message_id }));
        return text(`Sent from ${acc.email}.`);
      } catch (e) {
        return fail(errorText(env, e));
      }
    },
  );

  server.registerTool(
    "update_email",
    {
      title: "Archive / mark / star / trash",
      description: "Apply an action to one or more messages in one inbox: archive, mark_read, mark_unread, star, unstar, or trash.",
      inputSchema: {
        account: singleAccountArg,
        message_ids: z.array(z.string()).min(1).max(50),
        action: z.enum(["archive", "mark_read", "mark_unread", "star", "unstar", "trash"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ account, message_ids, action }) => {
      try {
        const acc = oneAccount(user, account);
        const client = await clientFor(env, user, acc);
        const results = await Promise.allSettled(message_ids.map((id) => client.modify(id, action)));
        const failed = results
          .map((r, i) => (r.status === "rejected" ? `${message_ids[i]}: ${errorText(env, r.reason)}` : ""))
          .filter(Boolean);
        const ok = message_ids.length - failed.length;
        return failed.length
          ? fail(`${action}: ${ok} succeeded, ${failed.length} failed in ${acc.email}.\n${failed.join("\n")}`)
          : text(`${action}: done for ${ok} message${ok === 1 ? "" : "s"} in ${acc.email}.`);
      } catch (e) {
        return fail(errorText(env, e));
      }
    },
  );

  return server;
}

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext<AuthProps>): Promise<Response> {
    const user: User = (await getUser(env, ctx.props.userId)) ?? {
      id: ctx.props.userId,
      createdAt: "",
      allowSend: false,
      accounts: [],
    };
    const server = buildServer(env, user);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
