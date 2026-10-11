import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createAppServer } from "./server.ts";

const server = createAppServer();
beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
afterAll(() => server.close());

test("GET /health returns 200 with the service name", async () => {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ service: "shareglow-mcp", ok: true });
});
