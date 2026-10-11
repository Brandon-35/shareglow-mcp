import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createAppServer } from "../server.ts";

const KEY = "sk_live_testkey123";
let api: Server;
let mcp: Server;
const seenAuth: (string | undefined)[] = [];

const port = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r));

beforeAll(async () => {
  // Mock REST API (stands in for T40's /v1): echoes the route it served.
  api = createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ served: `${req.method} ${req.url}` }));
  });
  await listen(api);
  mcp = createAppServer({ baseUrl: `http://127.0.0.1:${port(api)}` });
  await listen(mcp);
});
afterAll(() => {
  api.close();
  mcp.close();
});

function connect(key: string | null) {
  const client = new Client({ name: "t", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port(mcp)}/mcp`), {
    requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : {},
  });
  return { client, ready: client.connect(transport) };
}

test("a client lists the 7 tools and calls each one over Streamable HTTP", async () => {
  const { client, ready } = connect(KEY);
  await ready;
  expect((await client.listTools()).tools).toHaveLength(7);
  const calls: [string, Record<string, unknown>, string][] = [
    ["scan_url", { url: "https://example.com" }, "POST /v1/scan"],
    ["generate_og_image", { templateId: "bold", params: { title: "x" } }, "POST /v1/images"],
    ["create_template_from_url", { url: "https://example.com" }, "POST /v1/templates/from-url"],
    ["list_templates", {}, "GET /v1/templates"],
    ["create_short_link", { destination: "https://example.com" }, "POST /v1/links"],
    ["get_link_stats", { linkId: "l1" }, "GET /v1/links/l1/stats"],
    ["refresh_preview", { url: "https://example.com" }, "POST /v1/refresh"],
  ];
  for (const [name, args, served] of calls) {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0]?.text ?? "")).toEqual({ served });
  }
  expect(seenAuth.every((a) => a === `Bearer ${KEY}`)).toBe(true);
  await client.close();
});

test("a missing or malformed key is rejected with 401", async () => {
  for (const auth of [undefined, "Bearer nope", "Basic abc"]) {
    const res = await fetch(`http://127.0.0.1:${port(mcp)}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  }
});

test("a present Origin is rejected unless allow-listed", async () => {
  const post = (origin?: string) =>
    fetch(`http://127.0.0.1:${port(mcp)}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${KEY}`,
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  expect((await post("https://evil.example")).status).toBe(403);
  expect((await post()).status).toBe(200);
  const allowed = createAppServer({ baseUrl: "http://127.0.0.1:1", allowedOrigins: ["https://ok.example"] });
  await listen(allowed);
  const res = await fetch(`http://127.0.0.1:${port(allowed)}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${KEY}`,
      origin: "https://ok.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(200);
  allowed.close();
});
