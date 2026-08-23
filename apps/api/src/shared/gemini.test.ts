import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GEMINI_MODEL,
  GeminiAuthError,
  GeminiClient,
  GeminiEmptyReplyError,
  GeminiRequestError,
} from "./gemini.js";
import { ModelReplyError } from "./model-json.js";

/**
 * Asking Gemini to read a document.
 *
 * These prove the request is BUILT right, the failures are CLASSIFIED right,
 * and a rate limit is retried while a bad prompt is not. They do not prove
 * Google accepts it — nothing short of a real key does, and that is said in
 * the module rather than implied by a green suite.
 */

const reply = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

function stubFetch(...answers: Array<Partial<Response> & { json?: () => Promise<unknown> }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = answers[Math.min(index, answers.length - 1)] ?? {};
    index += 1;
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: answer.json ?? (() => Promise.resolve(reply('{"ok":true}'))),
      text: answer.text ?? (() => Promise.resolve("")),
      ...answer,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (impl: typeof fetch, over: Record<string, unknown> = {}) =>
  new GeminiClient({
    apiKey: "key-1",
    baseUrl: "https://gemini.test",
    fetchImpl: impl,
    // No real waiting: a retry test that sleeps for seconds is a test nobody
    // runs.
    sleep: () => Promise.resolve(),
    ...over,
  });

const ASK = { prompt: "Read this.", document: { mimeType: "application/pdf", data: "YmFzZTY0" } };

describe("building the request", () => {
  it("posts to the pinned model", async () => {
    // An alias that advances means an extraction's answers can change without
    // anything here changing — a figure moving with no commit to blame.
    const { impl, calls } = stubFetch({});
    await client(impl).ask(ASK);
    expect(calls[0]!.url).toBe(
      `https://gemini.test/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    );
  });

  it("puts the key in a header, never in the URL", async () => {
    // A URL reaches access logs, error reports and proxy caches. A key in one
    // of those is a key that has to be rotated.
    const { impl, calls } = stubFetch({});
    await client(impl).ask(ASK);
    expect(calls[0]!.url).not.toContain("key-1");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("key-1");
  });

  it("sends the document and the prompt, document first", async () => {
    const { impl, calls } = stubFetch({});
    await client(impl).ask(ASK);
    const body = JSON.parse(String(calls[0]!.init!.body)) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0]!.parts[0]).toEqual({
      inline_data: { mime_type: "application/pdf", data: "YmFzZTY0" },
    });
    expect(body.contents[0]!.parts[1]).toEqual({ text: "Read this." });
  });

  it("sends a prompt with no document at all", async () => {
    const { impl, calls } = stubFetch({});
    await client(impl).ask({ prompt: "Just answer." });
    const body = JSON.parse(String(calls[0]!.init!.body)) as {
      contents: Array<{ parts: unknown[] }>;
    };
    expect(body.contents[0]!.parts).toHaveLength(1);
  });

  it("takes a model override for one call", async () => {
    const { impl, calls } = stubFetch({});
    await client(impl).ask({ ...ASK, model: "gemini-1.5-pro" });
    expect(calls[0]!.url).toContain("gemini-1.5-pro:generateContent");
  });

  it("refuses to be built without a key", () => {
    // A configuration mistake found when somebody uploads a document is a
    // mistake found in front of a client.
    expect(() => new GeminiClient({ apiKey: "" })).toThrow(/GEMINI_API_KEY/);
  });
});

describe("reading the answer", () => {
  it("returns the text", async () => {
    const { impl } = stubFetch({ json: () => Promise.resolve(reply("hello")) });
    expect(await client(impl).ask(ASK)).toBe("hello");
  });

  it("joins a reply split across parts", async () => {
    // A long answer comes back in several parts, and taking only the first
    // truncates it mid-JSON.
    const { impl } = stubFetch({
      json: () =>
        Promise.resolve({
          candidates: [{ content: { parts: [{ text: '{"a"' }, { text: ":1}" }] } }],
        }),
    });
    expect(await client(impl).ask(ASK)).toBe('{"a":1}');
  });

  it("parses JSON out of a fenced reply", async () => {
    const { impl } = stubFetch({
      json: () => Promise.resolve(reply('```json\n{"year":2024}\n```')),
    });
    expect(await client(impl).askForJson(ASK)).toEqual({ year: 2024 });
  });

  it("says so when the reply carries no JSON", async () => {
    const { impl } = stubFetch({ json: () => Promise.resolve(reply("I could not read it.")) });
    await expect(client(impl).askForJson(ASK)).rejects.toBeInstanceOf(ModelReplyError);
  });
});

describe("when there is nothing to read", () => {
  it("says WHY when a prompt was refused", async () => {
    // A blocked prompt comes back 200 with no candidates and a reason. Reading
    // it as "no text" hides that the document tripped a safety filter rather
    // than failing to parse.
    const { impl } = stubFetch({
      json: () => Promise.resolve({ promptFeedback: { blockReason: "SAFETY" } }),
    });
    const error = await client(impl)
      .ask(ASK)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(GeminiEmptyReplyError);
    expect(error!.message).toContain("SAFETY");
  });

  it("names the finish reason when there is one", async () => {
    const { impl } = stubFetch({
      json: () => Promise.resolve({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    });
    await expect(client(impl).ask(ASK)).rejects.toThrow(/MAX_TOKENS/);
  });

  it("says plainly when the reply is simply empty", async () => {
    const { impl } = stubFetch({ json: () => Promise.resolve({ candidates: [] }) });
    await expect(client(impl).ask(ASK)).rejects.toBeInstanceOf(GeminiEmptyReplyError);
  });
});

describe("when Gemini refuses", () => {
  it("calls a rejected key what it is", async () => {
    for (const status of [401, 403]) {
      const { impl } = stubFetch({ status });
      await expect(client(impl).ask(ASK)).rejects.toBeInstanceOf(GeminiAuthError);
    }
  });

  it("reports any other status with what came back", async () => {
    const { impl } = stubFetch({ status: 400, text: () => Promise.resolve("Bad request") });
    await expect(client(impl).ask(ASK)).rejects.toThrow(/Bad request/);
  });

  it("truncates a long error body", async () => {
    const { impl } = stubFetch({ status: 500, text: () => Promise.resolve("x".repeat(5000)) });
    const error = await client(impl)
      .ask(ASK)
      .then(() => null)
      .catch((e: Error) => e);
    expect(error!.message.length).toBeLessThan(600);
  });
});

describe("retrying", () => {
  it("retries a rate limit and succeeds", async () => {
    // Gemini rate-limits with 429, and one attempt makes an extraction fail
    // for a reason that would have cleared in a second.
    const { impl, calls } = stubFetch(
      { status: 429, text: () => Promise.resolve("slow down") },
      { json: () => Promise.resolve(reply("done")) },
    );
    expect(await client(impl).ask(ASK)).toBe("done");
    expect(calls).toHaveLength(2);
  });

  it("retries a 503, which is load shedding rather than a fault", async () => {
    const { impl, calls } = stubFetch(
      { status: 503, text: () => Promise.resolve("") },
      { json: () => Promise.resolve(reply("done")) },
    );
    expect(await client(impl).ask(ASK)).toBe("done");
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 400", async () => {
    // The prompt or the document is wrong. Trying again produces the same 400
    // more slowly, and burns quota doing it.
    const { impl, calls } = stubFetch({ status: 400, text: () => Promise.resolve("bad") });
    await expect(client(impl).ask(ASK)).rejects.toBeInstanceOf(GeminiRequestError);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a rejected key", async () => {
    const { impl, calls } = stubFetch({ status: 401 });
    await expect(client(impl).ask(ASK)).rejects.toBeInstanceOf(GeminiAuthError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the attempts it was given", async () => {
    const { impl, calls } = stubFetch({ status: 429, text: () => Promise.resolve("") });
    await expect(client(impl, { maxAttempts: 3 }).ask(ASK)).rejects.toBeInstanceOf(
      GeminiRequestError,
    );
    expect(calls).toHaveLength(3);
  });

  it("backs off further each time rather than hammering", async () => {
    // Retrying a rate limit immediately is how a client earns a longer one.
    const waits: number[] = [];
    const { impl } = stubFetch({ status: 429, text: () => Promise.resolve("") });
    await client(impl, {
      maxAttempts: 3,
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    })
      .ask(ASK)
      .catch(() => null);
    expect(waits).toEqual([1000, 2000]);
  });

  it("can be told not to retry at all", async () => {
    const { impl, calls } = stubFetch({ status: 429, text: () => Promise.resolve("") });
    await expect(client(impl, { maxAttempts: 1 }).ask(ASK)).rejects.toBeInstanceOf(
      GeminiRequestError,
    );
    expect(calls).toHaveLength(1);
  });
});

describe("not waiting forever", () => {
  it("gives up rather than holding the request open", async () => {
    const impl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;
    await expect(client(impl, { timeoutMs: 10 }).ask(ASK)).rejects.toThrow(/abort/i);
  });

  it("clears its timer when the call succeeds", async () => {
    // A pending timer keeps the process alive past the request, which is how a
    // server stops shutting down cleanly.
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { impl } = stubFetch({});
    await client(impl).ask(ASK);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
