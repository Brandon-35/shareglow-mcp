#!/usr/bin/env node
import { createAppServer } from "./server.ts";
import { runStdio } from "./stdio.ts";

if (process.argv.includes("--http")) {
  const port = Number(process.env.PORT ?? 8791);
  createAppServer().listen(port, "127.0.0.1", () => {
    console.log(`shareglow-mcp listening on http://127.0.0.1:${port}/mcp`);
  });
} else {
  await runStdio(process.argv.slice(2), process.env);
}
