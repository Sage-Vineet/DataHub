import { describe, expect, it, vi } from "vitest";
import { createLegacyHierarchyWriter } from "./hierarchy.legacy.js";

/**
 * The single write path into `chart_of_accounts`.
 *
 * Small, and the most consequential file in the module: it is the only thing
 * here that changes a customer's chart of accounts. Three properties are worth
 * pinning — it targets the route that owns hierarchy, it forwards the caller's
 * own credentials rather than a service identity, and it does not send an actor
 * id, because legacy takes that from the authenticated request and a body that
 * could name a different one would be a way to forge an audit entry.
 */

/**
 * Parameters are declared even though the body ignores them: without them
 * `vi.fn` infers a zero-length call tuple, and every `mock.calls[0]` read below
 * becomes an index into an empty tuple.
 */
const ok = () =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ success: true }), { status: 200 }),
  );

const patch = { levels: ["Net Income", "Other Income", "Interest Income"], movedParent: true };

describe("createLegacyHierarchyWriter", () => {
  it("PATCHes the route that owns account hierarchy", async () => {
    const fetchImpl = ok();
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });

    await writer.updateAccountHierarchy("acc-1", patch, "user-1");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://legacy:4000/key-reports/chart-of-accounts/acc-1");
    expect(init?.method).toBe("PATCH");
  });

  it("sends the patch as the body, and no actor id", async () => {
    const fetchImpl = ok();
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });

    await writer.updateAccountHierarchy("acc-1", patch, "user-1");

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body).toEqual(patch);
    // Legacy takes the actor from the authenticated request. A userId in the
    // body would be a way to attribute a change to somebody else.
    expect(JSON.stringify(body)).not.toContain("user-1");
  });

  it("forwards the caller's own credentials", async () => {
    const fetchImpl = ok();
    const writer = createLegacyHierarchyWriter({
      origin: "http://legacy:4000",
      authorization: "Bearer minted-for-this-caller",
      cookie: "datahub.session_token=abc",
      fetchImpl,
    });

    await writer.updateAccountHierarchy("acc-1", patch, null);

    const headers = fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer minted-for-this-caller");
    expect(headers.cookie).toBe("datahub.session_token=abc");
  });

  it("sends no credential headers when the caller had none", async () => {
    // Legacy then refuses it, which is the correct outcome: an anonymous
    // caller must not be able to edit a chart of accounts through this.
    const fetchImpl = ok();
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });

    await writer.updateAccountHierarchy("acc-1", patch, null);

    const headers = fetchImpl.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });

  it("tolerates a trailing slash on the origin", async () => {
    const fetchImpl = ok();
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000/", fetchImpl });
    await writer.updateAccountHierarchy("acc-1", patch, null);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://legacy:4000/key-reports/chart-of-accounts/acc-1");
  });

  it("encodes the account id", async () => {
    const fetchImpl = ok();
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });
    await writer.updateAccountHierarchy("weird/id?x", patch, null);
    expect(fetchImpl.mock.calls[0]![0]).toContain("weird%2Fid%3Fx");
  });

  it("throws on a refusal, so the recommendation is not marked applied", async () => {
    // The service awaits this before recording the decision. Swallowing a 403
    // would leave a row claiming a change that never happened.
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });

    await expect(writer.updateAccountHierarchy("acc-1", patch, null)).rejects.toThrow(
      /legacy hierarchy update failed \(403\)/,
    );
  });

  it("includes the upstream detail, truncated", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("x".repeat(1000), { status: 500 }),
    );
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });

    const err = await writer
      .updateAccountHierarchy("acc-1", patch, null)
      .then(() => null)
      .catch((e: Error) => e);

    expect(err?.message).toContain("500");
    // Enough to diagnose, not enough to paste a stack trace into a log line.
    expect(err!.message.length).toBeLessThan(400);
  });

  it("still throws when the refusal has no readable body", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error("stream closed")),
    }) as unknown as Response);
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });

    await expect(writer.updateAccountHierarchy("acc-1", patch, null)).rejects.toThrow(/502/);
  });

  it("passes a reclassification's target type through", async () => {
    const fetchImpl = ok();
    const writer = createLegacyHierarchyWriter({ origin: "http://legacy:4000", fetchImpl });

    await writer.updateAccountHierarchy(
      "acc-1",
      { ...patch, accountType: "equity", statementType: "balance_sheet" },
      null,
    );

    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toMatchObject({
      accountType: "equity",
      statementType: "balance_sheet",
    });
  });
});
