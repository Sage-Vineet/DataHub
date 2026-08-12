import { describe, expect, it } from "vitest";
import {
  companyCreate,
  companyUpdate,
  normalizeProfitMetric,
} from "./companies.js";

describe("normalizeProfitMetric", () => {
  it("maps SDE aliases to 'sde'", () => {
    for (const v of ["sde", "SDE", "seller discretionary earnings", "sellers-discretionary-earnings"]) {
      expect(normalizeProfitMetric(v)).toBe("sde");
    }
  });

  it("maps adjusted-EBITDA aliases to 'adjusted_ebitda'", () => {
    for (const v of ["ebitda", "Adj EBITDA", "adjusted-ebitda", "ADJUSTED_EBITDA"]) {
      expect(normalizeProfitMetric(v)).toBe("adjusted_ebitda");
    }
  });

  it("falls back for empty/unknown input", () => {
    expect(normalizeProfitMetric("")).toBe("adjusted_ebitda");
    expect(normalizeProfitMetric(null)).toBe("adjusted_ebitda");
    expect(normalizeProfitMetric("nonsense")).toBe("adjusted_ebitda");
    expect(normalizeProfitMetric("nonsense", "sde")).toBe("sde");
  });
});

describe("companyCreate", () => {
  it("requires a name and normalizes the profit metric + contact email", () => {
    const parsed = companyCreate.parse({
      name: "  Acme  ",
      contact_email: "  Owner@Example.COM ",
      profit_metric: "Adj EBITDA",
    });
    expect(parsed.name).toBe("Acme");
    expect(parsed.contact_email).toBe("owner@example.com");
    expect(parsed.profit_metric).toBe("adjusted_ebitda");
  });

  it("rejects a missing/blank name", () => {
    expect(companyCreate.safeParse({}).success).toBe(false);
    expect(companyCreate.safeParse({ name: "   " }).success).toBe(false);
  });

  it("treats an empty contact email as absent (not invalid)", () => {
    const parsed = companyCreate.parse({ name: "Acme", contact_email: "" });
    expect(parsed.contact_email).toBeUndefined();
  });

  it("rejects a malformed contact email", () => {
    expect(companyCreate.safeParse({ name: "Acme", contact_email: "not-an-email" }).success).toBe(false);
  });
});

describe("companyUpdate", () => {
  it("is all-optional and omits integration-managed fields entirely", () => {
    expect(companyUpdate.safeParse({}).success).toBe(true);
    const parsed = companyUpdate.parse({
      quickbooks_connected: true,
      data_source_type: "manual",
      name: "New",
    } as Record<string, unknown>);
    // Unknown/unsafe keys are stripped — they can never reach the DB via update.
    expect("quickbooks_connected" in parsed).toBe(false);
    expect("data_source_type" in parsed).toBe(false);
    expect(parsed.name).toBe("New");
  });
});
