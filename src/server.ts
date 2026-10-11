import { createServer, type IncomingMessage, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createApiClient } from "./api.ts";
import { registerTools } from "./tools.ts";

export const DEFAULT_API_URL = "https://app.getshareglow.com";
export const SERVER_VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;

/** One MCP server instance bound to one caller's key (pass-through; no key of our own). */
export function createMcpServer(opts: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch }): McpServer {
  const server = new McpServer({ name: "shareglow", version: SERVER_VERSION });
  registerTools(server, createApiClient(opts), opts.apiKey);
  return server;
}

function bearer(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(sk_live_[A-Za-z0-9]+)$/.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Streamable HTTP at POST /mcp (stateless: a fresh server + transport per request, keyed by the Bearer key). */
export function createAppServer(
  opts: { baseUrl?: string; fetchImpl?: typeof fetch; allowedOrigins?: string[] } = {},
): Server {
  const allowedOrigins =
    opts.allowedOrigins ??
    (process.env.SHAREGLOW_MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  const baseUrl = opts.baseUrl ?? process.env.SHAREGLOW_API_URL ?? DEFAULT_API_URL;
  const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/health") return send(res, 200, { service: "shareglow-mcp", ok: true });
    if (path !== "/mcp") return send(res, 404, { error: "not_found" });
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
    // MCP spec: validate Origin against DNS rebinding. No Origin (non-browser clients) passes.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      return send(res, 403, { jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed." }, id: null });
    }
    const apiKey = bearer(req);
    if (!apiKey) {
      res.setHeader("www-authenticate", 'Bearer realm="shareglow"');
      return send(res, 401, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Send Authorization: Bearer sk_live_..." },
        id: null,
      });
    }
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Invalid JSON body." }, id: null });
    }
    const server = createMcpServer({ apiKey, baseUrl, fetchImpl: opts.fetchImpl });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent)
        send(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
    }
  });
}
