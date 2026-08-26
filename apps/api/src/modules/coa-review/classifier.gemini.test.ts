import { describe, expect, it, vi } from "vitest";
import { createGeminiClassifier, type GenerativeClient } from "./classifier.gemini.js";

/**
 * The model adapter's only interesting behaviour is how it fails.
 *
 * A 404 and a 429 mean different things — "this key cannot use this model" and
 * "this model is busy" — and treating them alike costs either latency or a
 * recoverable call. Everything else it does is hand the prompt over and hand the
 * text back, deliberately: parsing and validation belong to the engine, and an
 * adapter that parsed would be a second place a malformed answer could be
 * repaired into a plausible one.
 */

/** A client whose responses are scripted per call. */
function scriptedClient(responses: (string | Error)[]): {
  client: GenerativeClient;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    client: {
      getGenerativeModel({ model }) {
        return {
          async generateContent() {
            calls.push(model);
            const next = responses[i++];
            if (next instanceof Error) throw next;
            if (next === undefined) throw new Error("no scripted response");
            return { response: { text: () => next } };
          },
        };
      },
    },
  };
}

const silent = { warn: () => {} };
const noSleep = async () => {};

describe("createGeminiClassifier", () => {
  it("returns the text and the model that produced it", async () => {
    const { client } = scriptedClient(['{"recommendations":[]}']);
    const classifier = createGeminiClassifier({
      apiKey: "k",
      createClient: () => client,
      models: ["gemini-2.5-flash-lite"],
      logger: silent,
    });

    await expect(classifier.review("prompt")).resolves.toEqual({
      text: '{"recommendations":[]}',
      model: "gemini-2.5-flash-lite",
    });
  });

  it("hands back the raw text, parsing nothing", async () => {
    // Including the markdown fence models add unbidden — stripping it here
    // would put response repair in two places.
    const { client } = scriptedClient(["```json\n{}\n```"]);
    const classifier = createGeminiClassifier({
      apiKey: "k",
      createClient: () => client,
      models: ["m"],
      logger: silent,
    });

    const { text } = await classifier.review("prompt");
    expect(text).toBe("```json\n{}\n```");
  });

  it("refuses without an API key, before calling anything", async () => {
    const { client, calls } = scriptedClient(["never"]);
    const classifier = createGeminiClassifier({
      apiKey: "",
      createClient: () => client,
      logger: silent,
    });

    await expect(classifier.review("p")).rejects.toThrow(/GEMINI_API_KEY/);
    expect(calls).toEqual([]);
  });

  describe("model fallback", () => {
    it("moves to the next model when one is unavailable to this key", async () => {
      const { client, calls } = scriptedClient([new Error("404 model not found"), "ok"]);
      const classifier = createGeminiClassifier({
        apiKey: "k",
        createClient: () => client,
        models: ["gone", "present"],
        logger: silent,
        sleep: noSleep,
      });

      await expect(classifier.review("p")).resolves.toMatchObject({ model: "present" });
      // Exactly once on the missing model: retrying a 404 is pure latency.
      expect(calls).toEqual(["gone", "present"]);
    });

    it("retries once on a quota refusal, then moves on", async () => {
      const { client, calls } = scriptedClient([
        new Error("429 quota exceeded"),
        new Error("429 quota exceeded"),
        "ok",
      ]);
      const classifier = createGeminiClassifier({
        apiKey: "k",
        createClient: () => client,
        models: ["busy", "free"],
        logger: silent,
        sleep: noSleep,
      });

      await expect(classifier.review("p")).resolves.toMatchObject({ model: "free" });
      // Twice on the rate-limited model — a short backoff often clears it —
      // then on to the next rather than a third attempt.
      expect(calls).toEqual(["busy", "busy", "free"]);
    });

    it("backs off before the quota retry", async () => {
      // Declared parameters, so `sleep.mock.calls[0][0]` is a typed number
      // rather than an index into an empty tuple.
      const sleep = vi.fn(async (_ms: number) => {});
      const { client } = scriptedClient([new Error("429 quota"), "ok"]);
      const classifier = createGeminiClassifier({
        apiKey: "k",
        createClient: () => client,
        models: ["busy"],
        logger: silent,
        sleep,
      });

      await classifier.review("p");
      expect(sleep).toHaveBeenCalledOnce();
      expect(sleep.mock.calls[0]![0]).toBeGreaterThan(0);
    });

    it("does not retry an error that is neither quota nor missing", async () => {
      const { client, calls } = scriptedClient([new Error("500 internal"), "ok"]);
      const classifier = createGeminiClassifier({
        apiKey: "k",
        createClient: () => client,
        models: ["a", "b"],
        logger: silent,
        sleep: noSleep,
      });

      await expect(classifier.review("p")).resolves.toMatchObject({ model: "b" });
      expect(calls).toEqual(["a", "b"]);
    });

    it("throws once every model is exhausted, naming the last failure", async () => {
      const { client } = scriptedClient([new Error("404 a"), new Error("404 b")]);
      const classifier = createGeminiClassifier({
        apiKey: "k",
        createClient: () => client,
        models: ["a", "b"],
        logger: silent,
        sleep: noSleep,
      });

      // Not swallowed: the service is fail-soft around this and reports the
      // check unavailable, which is a different thing from "no recommendations".
      await expect(classifier.review("p")).rejects.toThrow(/reasonableness review call failed/);
    });

    it("logs each failure so an outage is visible without a debugger", async () => {
      const warn = vi.fn();
      const { client } = scriptedClient([new Error("404 a"), "ok"]);
      const classifier = createGeminiClassifier({
        apiKey: "k",
        createClient: () => client,
        models: ["a", "b"],
        logger: { warn },
        sleep: noSleep,
      });

      await classifier.review("p");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("model a failed"));
    });
  });
});
