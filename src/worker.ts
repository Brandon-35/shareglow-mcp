// Cloudflare Workers entry for the remote endpoint (mcp.getshareglow.com): the same stateless Streamable HTTP flow as
// createAppServer in server.ts, on the SDK's fetch-based transport. Tools and the REST client are shared.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ApiCallError, createApiClient } from "./api.ts";
import { createMcpServer, DEFAULT_API_URL, SERVER_VERSION } from "./server.ts";

export interface Env {
  /** REST base the tools call (default https://app.getshareglow.com). */
  SHAREGLOW_API_URL?: string;
  /** Comma-separated browser Origins allowed to call /mcp. Requests without an Origin header always pass. */
  SHAREGLOW_MCP_ALLOWED_ORIGINS?: string;
}

const MAX_BODY_BYTES = 1_000_000;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

/** True once the streamed body passes the cap; Content-Length is optional and can lie, so count the bytes. */
async function bodyExceedsCap(request: Request): Promise<boolean> {
  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return false;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      // Not awaited: on a tee'd clone the cancel only settles once the other branch is cancelled too.
      void reader.cancel();
      return true;
    }
  }
}

const PUBLIC_METHODS = new Set(["initialize", "ping", "tools/list"]);

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export async function handle(request: Request, env: Env, fetchImpl?: typeof fetch): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") return reply(200, { service: "shareglow-mcp", ok: true });
  // Static server card for registries that cannot scan a Bearer-key server (Smithery): the tool list never calls the API.
  if (pathname === "/.well-known/mcp/server-card.json") {
    const list = await handle(
      new Request(new URL("/mcp", request.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer sk_live_servercard",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    const { result } = (await list.json()) as { result?: { tools?: unknown[] } };
    return reply(200, {
      serverInfo: { name: "shareglow", version: SERVER_VERSION },
      authentication: { required: true, schemes: ["bearer"] },
      tools: result?.tools ?? [],
      resources: [],
      prompts: [],
    });
  }
  if (pathname !== "/mcp") return reply(404, { error: "not_found" });
  if (request.method !== "POST") return reply(405, rpcError(-32000, "Method not allowed."), { allow: "POST" });

  const origin = request.headers.get("origin");
  const allowed = (env.SHAREGLOW_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (origin !== null && !allowed.includes(origin)) return reply(403, rpcError(-32000, "Origin not allowed."));

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES || (await bodyExceedsCap(request))) {
    return reply(413, rpcError(-32700, "Body too large."));
  }
  const rpcBody = (await request
    .clone()
    .json()
    .catch(() => null)) as { method?: unknown } | null;
  const method = typeof rpcBody?.method === "string" ? rpcBody.method : "";
  const apiKey = /^Bearer\s+(sk_live_[A-Za-z0-9]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  // Directories (Glama, awesome-remote-mcp-servers CI) handshake without a key. Discovery never calls the API,
  // so only tool calls need one.
  if (!apiKey && !PUBLIC_METHODS.has(method) && !method.startsWith("notifications/")) {
    return reply(401, rpcError(-32001, "Send Authorization: Bearer sk_live_..."), {
      "www-authenticate": 'Bearer realm="shareglow"',
    });
  }

  const baseUrl = env.SHAREGLOW_API_URL ?? DEFAULT_API_URL;
  // A well-formed key proves nothing: check it once per session, on initialize. Only a 401 rejects it; a
  // network error or 429 must not lock out a valid key (tool calls surface those themselves).
  if (apiKey && method === "initialize") {
    try {
      await createApiClient({ baseUrl, apiKey, fetchImpl }).call("GET", "/v1/templates");
    } catch (err) {
      if (err instanceof ApiCallError && err.status === 401) {
        return reply(401, rpcError(-32001, "Invalid API key."), { "www-authenticate": 'Bearer realm="shareglow"' });
      }
    }
  }
  const server = createMcpServer({ apiKey: apiKey ?? "", baseUrl, fetchImpl });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch {
    return reply(500, rpcError(-32603, "Internal error."));
  }
}

/** Baseline hardening headers; rebuilds the Response because redirect and fetched responses have immutable headers. */
function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return out;
}

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => withSecurityHeaders(await handle(request, env)),
};
