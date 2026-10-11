// stdio entry for `npx shareglow-mcp`: key from SHAREGLOW_API_KEY or --api-key.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, DEFAULT_API_URL } from "./server.ts";

export function parseApiKey(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const i = argv.indexOf("--api-key");
  return (i >= 0 ? argv[i + 1] : undefined) ?? env.SHAREGLOW_API_KEY;
}

export async function runStdio(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const apiKey = parseApiKey(argv, env);
  if (!apiKey) {
    console.error("shareglow-mcp: set SHAREGLOW_API_KEY or pass --api-key sk_live_...");
    process.exit(1);
  }
  const server = createMcpServer({ apiKey, baseUrl: env.SHAREGLOW_API_URL ?? DEFAULT_API_URL });
  await server.connect(new StdioServerTransport());
}
