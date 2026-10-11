// Thin REST client: forwards the caller's sk_live_ key to /v1, never holds credentials of its own.
import { isIP } from "node:net";

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2_000_000;

export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClient {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}

/** Replaces every occurrence of the key so it can never reach a tool result. */
export function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ApiCallError(502, "response_too_large", "The Shareglow API response was too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApiClient(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): ApiClient {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async call(method, path, body) {
      let res: Response;
      try {
        res = await doFetch(new URL(path, opts.baseUrl), {
          method,
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            "user-agent": "shareglow-mcp",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          // workerd rejects redirect "error" (fetch throws), so take the 3xx as is: it fails the res.ok check below.
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw new ApiCallError(
          timedOut ? 504 : 502,
          timedOut ? "timeout" : "unreachable",
          timedOut ? "The Shareglow API timed out." : "The Shareglow API is unreachable.",
        );
      }
      const text = await readCapped(res);
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
        const retry = res.headers.get("retry-after");
        throw new ApiCallError(
          res.status,
          err?.code ?? "error",
          (err?.message ?? "Request failed.") + (res.status === 429 && retry ? ` Retry after ${retry}s.` : ""),
          err?.details,
        );
      }
      return json;
    },
  };
}

/** Defense in depth on top of the API's SSRF guard: http(s) only, no literal private/loopback hosts. */
export function assertPublicHttpUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiCallError(400, "invalid_url", "Not a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiCallError(400, "invalid_url", "Only http and https URLs are allowed.");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d+)\.(\d+)\./.exec(host);
  const privateV4 =
    isIP(host) === 4 &&
    v4 !== null &&
    (v4[1] === "10" ||
      v4[1] === "127" ||
      v4[1] === "0" ||
      (v4[1] === "169" && v4[2] === "254") ||
      (v4[1] === "192" && v4[2] === "168") ||
      (v4[1] === "172" && Number(v4[2]) >= 16 && Number(v4[2]) <= 31));
  const privateV6 = isIP(host) === 6 && /^(::1?$|f[cd]|fe80|::ffff:)/.test(host);
  if (privateV4 || privateV6 || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new ApiCallError(400, "private_ip", "Private or local addresses are not allowed.");
  }
}
