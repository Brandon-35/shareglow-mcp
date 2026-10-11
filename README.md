# shareglow-mcp

MCP server for [Shareglow](https://getshareglow.com): scan link previews, generate Open Graph images, create short links with their own preview, and read click stats from any MCP client.

It is a thin client of the Shareglow REST API (`/v1`). Your API key is passed straight through, so plan limits and rate limits apply unchanged. The server holds no credentials of its own.

## Hosted endpoint

```
https://mcp.getshareglow.com/mcp
Authorization: Bearer sk_live_...
```

Transport: Streamable HTTP. Create an API key at https://app.getshareglow.com/developer.

## Tools

| Tool | Description |
| --- | --- |
| `scan_url` | Scan a public web page and report its link-preview (Open Graph / Twitter Card) metadata, previews per platform, and issues with fix suggestions. |
| `generate_og_image` | Render a 1200x630 Open Graph image from a template id (see `list_templates`) and text params such as title and subtitle. Returns the permanent image URL and whether it was cached. Optional `exp` (Unix seconds, paid plans) makes the signed URL expire. |
| `create_template_from_url` | Use AI to design a new OG image template from a website's brand (logo, colors, fonts) taken from a URL. Returns the layout id, the variables to pass, and the extracted brand kit. Counts against the plan's AI quota. |
| `list_templates` | List the OG image templates the workspace can render (built-in and custom) with id, name, version and dimensions. |
| `create_short_link` | Create a short link with its own link preview. Optional custom slug and optional A/B variants (title, description, imageUrl or templateId). Returns id, shortUrl and variants. |
| `get_link_stats` | Get click analytics for a short link by id: totals plus breakdowns by day, country, device, browser and referrer. Optional `from`/`to` dates (YYYY-MM-DD). |
| `refresh_preview` | Force social platforms to re-fetch a page's link preview after you changed its OG tags or image: bumps the og:image cache-buster, re-scrapes Facebook, and returns the LinkedIn Post Inspector link and the X cache note. |

## Client setup

### Claude Code

```
claude mcp add --transport http shareglow https://mcp.getshareglow.com/mcp \
  --header "Authorization: Bearer sk_live_..."
```

### Claude Desktop

Claude Desktop reaches remote servers through `mcp-remote`. Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shareglow": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.getshareglow.com/mcp", "--header", "Authorization:${AUTH}"],
      "env": { "AUTH": "Bearer sk_live_..." }
    }
  }
}
```

Or skip the remote and use the stdio server below.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "shareglow": {
      "url": "https://mcp.getshareglow.com/mcp",
      "headers": { "Authorization": "Bearer sk_live_..." }
    }
  }
}
```

### Local stdio (any client)

```json
{
  "mcpServers": {
    "shareglow": {
      "command": "npx",
      "args": ["-y", "shareglow-mcp"],
      "env": { "SHAREGLOW_API_KEY": "sk_live_..." }
    }
  }
}
```

The key can also be passed as `--api-key sk_live_...`. `SHAREGLOW_API_URL` points the server at another REST base (default `https://app.getshareglow.com`).

## Errors and limits

- Each tool needs the key scope of its REST call. A key without it gets `403 insufficient_scope`.
- REST `401`, `402`, `403` and `429` become MCP tool errors (`isError: true`) that carry the API's message.
- URLs are validated before forwarding (http/https, no private or local hosts).
- Tool results are truncated at 20,000 characters. The API key is redacted from every result and error.

## Local development

```
npm install
npm run typecheck
npm test
npm run build
npm run dev          # Streamable HTTP on PORT (default 8791)
npm run dev:worker   # Cloudflare Worker via wrangler dev
```

Node 22 or newer is required.

## License

MIT, see [LICENSE](LICENSE).
