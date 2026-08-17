import type { Json } from "./normalize.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequest {
  method: Method;
  path: string;
  query?: Readonly<Record<string, string>>;
  body?: Json;
  headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON when the response is JSON; otherwise the raw text. */
  body: Json;
  contentType: string | null;
  /** Set-Cookie values, needed to carry a Better Auth session between calls. */
  setCookie: string[];
  durationMs: number;
}

function buildUrl(baseUrl: string, path: string, query?: Readonly<Record<string, string>>): string {
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, ensureTrailingSlash(baseUrl));
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function ensureTrailingSlash(base: string): string {
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * Read Set-Cookie as a list. `Headers.getSetCookie()` is the only correct way —
 * joining them with `get()` corrupts cookies whose Expires attribute contains a
 * comma, which is exactly the shape Better Auth emits.
 */
function readSetCookie(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

async function readBody(response: Response): Promise<{ body: Json; contentType: string | null }> {
  const contentType = response.headers.get("content-type");
  const text = await response.text();
  if (text === "") return { body: null, contentType };
  if (contentType?.includes("application/json")) {
    try {
      return { body: JSON.parse(text) as Json, contentType };
    } catch {
      // A body that claims JSON but is not parseable is itself a finding — keep
      // the raw text so the diff shows it rather than throwing the run away.
      return { body: text, contentType };
    }
  }
  return { body: text, contentType };
}

export async function send(
  baseUrl: string,
  request: HttpRequest,
  timeoutMs = 15_000,
): Promise<HttpResponse> {
  const url = buildUrl(baseUrl, request.path, request.query);
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  let payload: string | undefined;
  if (request.body !== undefined) {
    payload = JSON.stringify(request.body);
    headers["content-type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: payload,
      redirect: "manual", // a redirect is a behaviour difference, not something to follow
      signal: controller.signal,
    });
    const { body, contentType } = await readBody(response);
    return {
      status: response.status,
      body,
      contentType,
      setCookie: readSetCookie(response.headers),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reduce Set-Cookie headers to a Cookie request header. */
export function cookieHeader(setCookie: readonly string[]): string {
  return setCookie
    .map((c) => c.split(";", 1)[0]?.trim())
    .filter((c): c is string => Boolean(c))
    .join("; ");
}
