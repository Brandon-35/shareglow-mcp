import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";
import { MAX_RESULT_CHARS } from "../tools.ts";
import { createMcpServer } from "../server.ts";

const KEY = "sk_live_abc123SECRET";
interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

async function setup(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const server = createMcpServer({ apiKey: KEY, baseUrl: "http://api.test", fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return { client, calls };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(b, { status, headers });
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";

test("lists exactly the seven tools", async () => {
  const { client } = await setup(() => json({}));
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(
    [
      "create_short_link",
      "create_template_from_url",
      "generate_og_image",
      "get_link_stats",
      "list_templates",
      "refresh_preview",
      "scan_url",
    ].sort(),
  );
});

test("each tool maps to its REST endpoint and forwards the caller key", async () => {
  const { client, calls } = await setup(() => json({ ok: true }));
  await client.callTool({ name: "scan_url", arguments: { url: "https://example.com" } });
  await client.callTool({ name: "generate_og_image", arguments: { templateId: "bold", params: { title: "Hi" } } });
  await client.callTool({ name: "create_template_from_url", arguments: { url: "https://example.com" } });
  await client.callTool({ name: "list_templates", arguments: {} });
  await client.callTool({
    name: "create_short_link",
    arguments: { destination: "https://example.com", slug: "hi", variants: [{ title: "B" }] },
  });
  await client.callTool({ name: "get_link_stats", arguments: { linkId: "l_1", from: "2026-01-01" } });
  await client.callTool({ name: "refresh_preview", arguments: { url: "https://example.com" } });
  expect(calls.map((c) => `${c.method} ${c.url.replace("http://api.test", "")}`)).toEqual([
    "POST /v1/scan",
    "POST /v1/images",
    "POST /v1/templates/from-url",
    "GET /v1/templates",
    "POST /v1/links",
    "GET /v1/links/l_1/stats?from=2026-01-01",
    "POST /v1/refresh",
  ]);
  expect(calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
  expect(calls[4]?.body).toEqual({ destination: "https://example.com", slug: "hi", variants: [{ title: "B" }] });
});

test("schemas reject malformed input before any REST call", async () => {
  const { client, calls } = await setup(() => json({}));
  const bad = [
    { name: "scan_url", arguments: { url: "not a url" } },
    { name: "scan_url", arguments: {} },
    { name: "generate_og_image", arguments: { templateId: "bold", params: { title: 5 } } },
    { name: "create_short_link", arguments: { destination: "https://e.com", slug: "a b" } },
    { name: "get_link_stats", arguments: { linkId: "../x" } },
    { name: "get_link_stats", arguments: { linkId: "l", from: "yesterday" } },
  ];
  for (const b of bad) {
    const r = await client.callTool(b).catch(() => ({ isError: true }));
    expect((r as { isError?: boolean }).isError).toBe(true);
  }
  expect(calls).toHaveLength(0);
});

test("private or non-http URLs are blocked client-side", async () => {
  const { client, calls } = await setup(() => json({}));
  for (const url of [
    "http://127.0.0.1/x",
    "http://10.0.0.5",
    "http://localhost:3000",
    "ftp://example.com/a",
    "http://[::1]/",
  ]) {
    const r = await client.callTool({ name: "scan_url", arguments: { url } });
    expect(r.isError).toBe(true);
  }
  expect(calls).toHaveLength(0);
});

test.each([
  [401, { error: { code: "unauthorized", message: "A valid Bearer API key is required." } }, "unauthorized"],
  [
    402,
    {
      error: { code: "plan_limit_exceeded", message: "The free plan allows 5 links.", details: { limit: 5, used: 5 } },
    },
    "5 links",
  ],
  [429, { error: { code: "rate_limited", message: "Daily limit reached." } }, "Daily limit reached. Retry after 60s."],
  [
    403,
    { error: { code: "insufficient_scope", message: "This API key lacks the required scope: templates." } },
    "lacks a scope this tool needs",
  ],
])("REST %i becomes an MCP error carrying the message", async (status, body, expected) => {
  const { client } = await setup(() => json(body, status, { "retry-after": "60" }));
  const r = await client.callTool({ name: "list_templates", arguments: {} });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain(`API error ${status}`);
  expect(text(r)).toContain(expected);
});

test("the API key never appears in results or errors", async () => {
  const echo = await setup(() => json({ echoed: `key is ${KEY}` }));
  expect(text(await echo.client.callTool({ name: "list_templates", arguments: {} }))).not.toContain(KEY);
  const err = await setup(() => json({ error: { code: "x", message: `bad ${KEY}` } }, 400));
  expect(text(await err.client.callTool({ name: "list_templates", arguments: {} }))).not.toContain(KEY);
});

test("oversized results are truncated", async () => {
  const { client } = await setup(() => json({ blob: "x".repeat(MAX_RESULT_CHARS * 2) }));
  const t = text(await client.callTool({ name: "list_templates", arguments: {} }));
  expect(t.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  expect(t).toContain("truncated");
});

test("an unreachable API gives an MCP error, not a crash", async () => {
  const server = createMcpServer({
    apiKey: KEY,
    baseUrl: "http://api.test",
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const r = await client.callTool({ name: "list_templates", arguments: {} });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("unreachable");
});

test("variant imageUrl goes through the same URL guard as destination", async () => {
  const { client, calls } = await setup(() => json({}));
  const r = await client.callTool({
    name: "create_short_link",
    arguments: { destination: "https://example.com", variants: [{ imageUrl: "http://169.254.169.254/x.png" }] },
  });
  expect(r.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("generate_og_image forwards exp only when given and rejects a non-integer exp", async () => {
  const { client, calls } = await setup(() => json({ url: "u" }));
  await client.callTool({ name: "generate_og_image", arguments: { templateId: "bold" } });
  await client.callTool({ name: "generate_og_image", arguments: { templateId: "bold", exp: 2_000_000_000 } });
  expect(calls[0]?.body).not.toHaveProperty("exp");
  expect((calls[1]?.body as { exp: number }).exp).toBe(2_000_000_000);
  const bad = await client
    .callTool({ name: "generate_og_image", arguments: { templateId: "bold", exp: 1.5 } })
    .catch(() => ({ isError: true }));
  expect((bad as { isError?: boolean }).isError).toBe(true);
  expect(calls).toHaveLength(2);
});
