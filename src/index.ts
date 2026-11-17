// Entry point. OAuthProvider makes this Worker an OAuth 2.1 authorization server for Claude:
// requests to /mcp need a valid token (and get the user's id in ctx.props); everything else
// (connect pages, dashboard, provider callbacks) goes to the web handler.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { publicUrl, type Env } from "./env";
import { mcpHandler } from "./mcp";
import { webHandler } from "./web";

let provider: OAuthProvider<Env> | undefined;
let providerFor = "";

function getProvider(env: Env): OAuthProvider<Env> {
  const base = publicUrl(env);
  if (!provider || providerFor !== base) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: webHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["mail"],
      resourceMetadata: {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        resource_name: "Multi-Inbox",
      },
      // Claude's token lasts an hour; the grant lives as long as it keeps being used (90-day idle window).
      accessTokenTTL: 3600,
      refreshTokenIdleTTL: 90 * 86400,
    });
    providerFor = base;
  }
  return provider;
}

export default {
  fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    // PUBLIC_URL is optional: by default the server uses whatever address it's served from.
    const env: Env = rawEnv.PUBLIC_URL ? rawEnv : { ...rawEnv, PUBLIC_URL: new URL(request.url).origin };
    const missing = ["ENCRYPTION_KEY", "SESSION_SECRET"].filter((k) => !env[k as keyof Env]);
    if (missing.length) {
      return Promise.resolve(
        new Response(`Server is missing configuration: ${missing.join(", ")}. See SETUP.md (step 2).`, { status: 500 }),
      );
    }
    return getProvider(env).fetch(request, env, ctx);
  },
};
