import { expect, test } from "vitest";
import { handle, type Env } from "./worker.ts";

const KEY = "sk_live_abc123";
const env: Env = { SHAREGLOW_API_URL: "https://api.test" };
const rpc = (method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
  new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${KEY}`,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

test("GET /health answers without auth", async () => {
  const res = await handle(new Request("https://mcp.test/health"), env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ service: "shareglow-mcp", ok: true });
});

test("rejects a missing key, a foreign Origin, GET and unknown paths", async () => {
  const noKey = await handle(rpc("tools/call", { name: "list_templates", arguments: {} }, { authorization: "" }), env);
  expect(noKey.status).toBe(401);
  expect(noKey.headers.get("www-authenticate")).toContain("Bearer");
  expect((await handle(rpc("tools/list", {}, { origin: "https://evil.test" }), env)).status).toBe(403);
  const allowed = { ...env, SHAREGLOW_MCP_ALLOWED_ORIGINS: "https://ok.test" };
  expect((await handle(rpc("tools/list", {}, { origin: "https://ok.test" }), allowed)).status).toBe(200);
  expect((await handle(new Request("https://mcp.test/mcp"), env)).status).toBe(405);
  expect((await handle(new Request("https://mcp.test/nope"), env)).status).toBe(404);
});

test("tools/list returns the seven tools", async () => {
  const res = await handle(rpc("tools/list"), env);
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools.map((t) => t.name).sort()).toEqual([
    "create_short_link",
    "create_template_from_url",
    "generate_og_image",
    "get_link_stats",
    "list_templates",
    "refresh_preview",
    "scan_url",
  ]);
});

test("a tool call forwards the caller's key to the configured REST base", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ templates: [] });
  };
  const res = await handle(rpc("tools/call", { name: "list_templates", arguments: {} }), env, fetchImpl);
  expect(res.status).toBe(200);
  expect(seen).toEqual([{ url: "https://api.test/v1/templates", auth: `Bearer ${KEY}` }]);
});

test("serves a static server card with the tool list and no key", async () => {
  const res = await handle(new Request("https://mcp.test/.well-known/mcp/server-card.json"), env);
  expect(res.status).toBe(200);
  const card = (await res.json()) as { serverInfo: { name: string }; authentication: unknown; tools: unknown[] };
  expect(card.serverInfo.name).toBe("shareglow");
  expect(card.authentication).toEqual({ required: true, schemes: ["bearer"] });
  expect(card.tools).toHaveLength(7);
});

test("rejects an oversized body even without a Content-Length header", async () => {
  const big = new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1_100_000) } }),
  });
  expect(big.headers.get("content-length")).toBeNull();
  expect((await handle(big, env)).status).toBe(413);
});
test("initialize rejects a key the API answers 401 for, tools/list does not call the API", async () => {
  const calls: string[] = [];
  const deny: typeof fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ error: { code: "unauthorized", message: "bad key" } }, { status: 401 });
  };
  const init = rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  const res = await handle(init, env, deny);
  expect(res.status).toBe(401);
  expect(calls).toEqual(["https://api.test/v1/templates"]);
  expect((await handle(rpc("tools/list"), env, deny)).status).toBe(200);
  expect(calls).toHaveLength(1);
});
test("initialize still works when the API is unreachable", async () => {
  const down: typeof fetch = async () => {
    throw new Error("offline");
  };
  const init = rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  expect((await handle(init, env, down)).status).toBe(200);
});
test("handshake and tools/list work without a key, tool calls do not", async () => {
  const calls: string[] = [];
  const spy: typeof fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ templates: [] });
  };
  const anon = { authorization: "" };
  const init = rpc(
    "initialize",
    { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    anon,
  );
  expect((await handle(init, env, spy)).status).toBe(200);
  expect((await handle(rpc("notifications/initialized", {}, anon), env, spy)).ok).toBe(true);
  const list = (await (await handle(rpc("tools/list", {}, anon), env, spy)).json()) as { result: { tools: unknown[] } };
  expect(list.result.tools).toHaveLength(7);
  expect((await handle(rpc("tools/call", { name: "list_templates", arguments: {} }, anon), env, spy)).status).toBe(401);
  expect(calls).toEqual([]);
});
test("without a key, batches and every other method stay 401", async () => {
  const anon = { authorization: "" };
  for (const m of ["resources/list", "prompts/list", "completion/complete", "nope"]) {
    expect((await handle(rpc(m, {}, anon), env)).status).toBe(401);
  }
  const batch = new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_templates", arguments: {} } },
    ]),
  });
  expect((await handle(batch, env)).status).toBe(401);
});

test("create_short_link rejects an uppercase slug like the REST API does", async () => {
  const fetchImpl: typeof fetch = async () => Response.json({});
  const res = await handle(
    rpc("tools/call", {
      name: "create_short_link",
      arguments: { destination: "https://example.com", slug: "Promo" },
    }),
    env,
    fetchImpl,
  );
  const body = (await res.json()) as { result?: { isError?: boolean } };
  expect(body.result?.isError).toBe(true);
});

test("tools/call without a name is -32602 with a short message", async () => {
  const res = await handle(rpc("tools/call", {}), env);
  const body = (await res.json()) as { error: { code: number; message: string } };
  expect(body.error.code).toBe(-32602);
  expect(body.error.message.length).toBeLessThan(120);
});
