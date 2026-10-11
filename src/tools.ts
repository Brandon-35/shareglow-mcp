import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiCallError, assertPublicHttpUrl, redact, type ApiClient } from "./api.ts";

/** Cap on text returned to the model so one scan/stats result cannot flood its context window. */
export const MAX_RESULT_CHARS = 20_000;

const url = z.string().url().max(2048);
const strings = z.record(z.string(), z.string().max(1000));

export function formatResult(data: unknown, apiKey: string): CallToolResult {
  let text = redact(JSON.stringify(data, null, 2) ?? "null", apiKey);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated: result exceeded ${MAX_RESULT_CHARS} characters]`;
  }
  return { content: [{ type: "text", text }] };
}

export function formatError(err: unknown, apiKey: string): CallToolResult {
  let text: string;
  if (err instanceof ApiCallError) {
    text = `Shareglow API error ${err.status} (${err.code}): ${err.message}`;
    if (err.details) text += `\nDetails: ${JSON.stringify(err.details)}`;
    if (err.code === "insufficient_scope") {
      text +=
        "\nThis API key lacks a scope this tool needs. Create a key with the listed scope in Developer > API keys.";
    }
    if (err.status === 401) text += "\nCheck that the Shareglow API key (sk_live_...) is set and not revoked.";
  } else {
    text = "Unexpected error while calling the Shareglow API.";
  }
  return { isError: true, content: [{ type: "text", text: redact(text, apiKey) }] };
}

/** Registers the seven tools. `api` already carries the caller's key; `apiKey` is only used for redaction. */
export function registerTools(server: McpServer, api: ApiClient, apiKey: string): void {
  const run = (fn: () => Promise<unknown>) => async (): Promise<CallToolResult> => {
    try {
      return formatResult(await fn(), apiKey);
    } catch (err) {
      return formatError(err, apiKey);
    }
  };
  const checked = (u: string) => {
    assertPublicHttpUrl(u);
    return u;
  };

  server.registerTool(
    "scan_url",
    {
      description:
        "Scan a public web page and report its link-preview (Open Graph / Twitter Card) metadata, previews per platform, and issues with fix suggestions. Use it to answer 'why does my link preview look wrong?'.",
      inputSchema: { url },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ url }) => run(() => api.call("POST", "/v1/scan", { url: checked(url) }))(),
  );

  server.registerTool(
    "generate_og_image",
    {
      description:
        "Render a 1200x630 Open Graph image from a template id (see list_templates) and text params such as title and subtitle. Returns the permanent image URL to put in og:image, and whether it was already cached. Optional exp (Unix seconds, paid plans) makes the signed URL expire; leave it out for an og:image URL.",
      inputSchema: {
        templateId: z.string().min(1).max(100),
        params: strings.optional(),
        exp: z.number().int().positive().optional(),
      },
    },
    ({ templateId, params, exp }) =>
      run(() =>
        api.call("POST", "/v1/images", { templateId, params: params ?? {}, ...(exp !== undefined && { exp }) }),
      )(),
  );

  server.registerTool(
    "create_template_from_url",
    {
      description:
        "Use AI to design a new OG image template from a website's brand (logo, colors, fonts) taken from a URL. Returns the chosen layoutId (a built-in template id usable with generate_og_image), the variables to pass, and the extracted brand kit. Counts against the plan's AI quota.",
      inputSchema: { url },
      annotations: { openWorldHint: true },
    },
    ({ url }) => run(() => api.call("POST", "/v1/templates/from-url", { url: checked(url) }))(),
  );

  server.registerTool(
    "list_templates",
    {
      description:
        "List the OG image templates the workspace can render (built-in and custom) with id, name, version and dimensions. Call this before generate_og_image to pick a templateId.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => api.call("GET", "/v1/templates"))(),
  );

  server.registerTool(
    "create_short_link",
    {
      description:
        "Create a short link with its own link preview. Optional custom slug, and optional A/B variants (each with a title, description, imageUrl or templateId) to test which preview gets more clicks. Returns id, shortUrl and variants. Use the id with get_link_stats.",
      inputSchema: {
        destination: url,
        slug: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
          .optional(),
        variants: z
          .array(
            z.object({
              title: z.string().max(200).optional(),
              description: z.string().max(500).optional(),
              imageUrl: url.optional(),
              templateId: z.string().max(100).optional(),
              params: strings.optional(),
            }),
          )
          .max(3)
          .optional(),
      },
    },
    ({ destination, slug, variants }) =>
      run(() =>
        api.call("POST", "/v1/links", {
          destination: checked(destination),
          ...(slug ? { slug } : {}),
          ...(variants?.length
            ? { variants: variants.map((v) => (v.imageUrl ? { ...v, imageUrl: checked(v.imageUrl) } : v)) }
            : {}),
        }),
      )(),
  );

  server.registerTool(
    "get_link_stats",
    {
      description:
        "Get click analytics for a short link by id (from create_short_link): totals plus breakdowns by day, country, device, browser and referrer. Optional from/to dates (YYYY-MM-DD).",
      inputSchema: {
        linkId: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w-]+$/),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ linkId, from, to }) => {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      const qs = q.size ? `?${q}` : "";
      return run(() => api.call("GET", `/v1/links/${encodeURIComponent(linkId)}/stats${qs}`))();
    },
  );

  server.registerTool(
    "refresh_preview",
    {
      description:
        "Force social platforms to re-fetch a page's link preview after you changed its OG tags or image: bumps the og:image cache-buster, re-scrapes Facebook, and returns the LinkedIn Post Inspector link and the X cache note.",
      inputSchema: { url },
      annotations: { openWorldHint: true },
    },
    ({ url }) => run(() => api.call("POST", "/v1/refresh", { url: checked(url) }))(),
  );
}
