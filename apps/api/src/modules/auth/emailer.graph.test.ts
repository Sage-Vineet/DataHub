import { describe, expect, it, vi } from "vitest";
import { GraphEmailer } from "./emailer.graph.js";

/** A mock `fetch` that records calls and returns scripted responses. */
function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? "")),
    } as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const opts = {
  tenantId: "tenant",
  clientId: "client",
  clientSecret: "secret",
  sender: "noreply@datahub.test",
};

describe("GraphEmailer", () => {
  it("throws if Graph is not configured", () => {
    expect(() => new GraphEmailer({ ...opts, tenantId: "" })).toThrow(/not configured/i);
    expect(() => GraphEmailer.fromEnv({} as NodeJS.ProcessEnv)).toThrow(/not configured/i);
  });

  it("fetches a token then delivers the OTP via sendMail (202)", async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: { access_token: "tok-123", expires_in: 3600 } },
      { status: 202 },
    ]);
    const emailer = new GraphEmailer({ ...opts, fetchFn: fn });

    const result = await emailer.sendOtp("user@example.com", "123456");
    expect(result.sent).toBe(true);

    // First call: token endpoint. Second: sendMail with Bearer + the code in the body.
    expect(calls[0].url).toContain("login.microsoftonline.com/tenant/oauth2/v2.0/token");
    expect(calls[1].url).toContain("graph.microsoft.com/v1.0/users/noreply%40datahub.test/sendMail");
    const headers = calls[1].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(String(calls[1].init?.body)).toContain("123456");
  });

  it("caches the token across sends (only one token fetch)", async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: { access_token: "tok-123", expires_in: 3600 } },
      { status: 202 },
      { status: 202 },
    ]);
    const emailer = new GraphEmailer({ ...opts, fetchFn: fn, now: () => 1_000 });
    await emailer.sendOtp("a@example.com", "111111");
    await emailer.sendOtp("b@example.com", "222222");
    const tokenCalls = calls.filter((c) => c.url.includes("/oauth2/v2.0/token"));
    expect(tokenCalls.length).toBe(1);
  });

  it("throws a helpful error when the token request fails", async () => {
    const { fn } = mockFetch([{ status: 401, body: { error: "invalid_client" } }]);
    const emailer = new GraphEmailer({ ...opts, fetchFn: fn });
    await expect(emailer.sendOtp("user@example.com", "123456")).rejects.toThrow(/Graph token error/);
  });

  it("throws when sendMail returns a non-202 status", async () => {
    const { fn } = mockFetch([
      { status: 200, body: { access_token: "tok-123", expires_in: 3600 } },
      { status: 500, body: "upstream boom" },
    ]);
    const emailer = new GraphEmailer({ ...opts, fetchFn: fn });
    await expect(emailer.sendOtp("user@example.com", "123456")).rejects.toThrow(/sendMail failed — HTTP 500/);
  });
});
