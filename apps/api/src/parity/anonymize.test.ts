import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@datahub/db";
import {
  anonymizeContactsSql,
  CONTACT_COLUMNS,
  looksLikeProductionContact,
  placeholderPhone,
  seedSql,
  sinkAddressFor,
  stagingMarkerSql,
} from "./anonymize.js";

const SINK = "sink.datahub-staging.test";

let client: PGlite;

const DDL = `
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, email text NOT NULL, phone text
);
CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, contact_email text, contact_phone text
);
CREATE TABLE key_report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL, version_number integer NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'
);
`;

// One database for the file, re-seeded per test: spinning up a PGlite instance
// costs ~5s, and eleven of them dominated the whole suite's runtime.
beforeAll(async () => {
  client = new PGlite();
  await client.exec(DDL);
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.exec("TRUNCATE users, companies, key_report_versions;");
  await client.exec("DROP TABLE IF EXISTS staging_marker;");
  await client.exec(`
    INSERT INTO users (name, email, phone) VALUES
      ('Real Seller', 'seller@realcustomer.com', '+14155550123'),
      ('Real Broker', 'broker@realbrokerage.com', NULL);
    INSERT INTO companies (name, contact_email, contact_phone) VALUES
      ('Acme Manufacturing', 'owner@acme-manufacturing.com', '+12125551234'),
      ('No Contact Co', NULL, NULL);
    INSERT INTO key_report_versions (company_id, version_number, metadata)
      VALUES (gen_random_uuid(), 1, '{"revenue": 4820000}');
  `);
});

describe("contact rewriting", () => {
  it("removes every production email and phone", async () => {
    await client.exec(anonymizeContactsSql({ sinkDomain: SINK }));

    const users = await client.query<{ email: string; phone: string | null }>(
      "SELECT email, phone FROM users",
    );
    for (const row of users.rows) {
      expect(row.email.endsWith(`@${SINK}`)).toBe(true);
      expect(looksLikeProductionContact(row.email, { sinkDomain: SINK })).toBe(false);
      expect(looksLikeProductionContact(row.phone, { sinkDomain: SINK })).toBe(false);
    }

    const companies = await client.query<{ contact_email: string | null }>(
      "SELECT contact_email FROM companies",
    );
    for (const row of companies.rows) {
      if (row.contact_email !== null) expect(row.contact_email.endsWith(`@${SINK}`)).toBe(true);
    }
  });

  it("leaves nulls null rather than inventing contact data", async () => {
    await client.exec(anonymizeContactsSql({ sinkDomain: SINK }));

    const nulls = await client.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM companies WHERE contact_email IS NULL AND contact_phone IS NULL",
    );
    expect(nulls.rows[0]!.c).toBe(1);
    const phone = await client.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM users WHERE phone IS NULL",
    );
    expect(phone.rows[0]!.c).toBe(1);
  });

  it("encodes the row id so a tester can still find the right mailbox", async () => {
    await client.exec(anonymizeContactsSql({ sinkDomain: SINK }));

    const row = (
      await client.query<{ id: string; email: string }>(
        "SELECT id, email FROM users WHERE name = 'Real Seller'",
      )
    ).rows[0]!;
    expect(row.email).toBe(sinkAddressFor(row.id, { sinkDomain: SINK }));
  });

  // The point of a production snapshot is production-shaped data. Anonymizing the
  // financial rows would defeat the parity comparison the snapshot exists for.
  it("leaves financial data untouched", async () => {
    const before = await client.query<{ metadata: unknown }>(
      "SELECT metadata FROM key_report_versions",
    );
    await client.exec(anonymizeContactsSql({ sinkDomain: SINK }));
    const after = await client.query<{ metadata: unknown }>(
      "SELECT metadata FROM key_report_versions",
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("produces phone numbers in the reserved, non-routable range", () => {
    expect(placeholderPhone("8f1e2d3c-4b5a")).toMatch(/^\+1555010\d{4}$/);
  });

  it("refuses an unsafe sink domain rather than interpolating it", () => {
    expect(() => anonymizeContactsSql({ sinkDomain: "evil'; DROP TABLE users; --" })).toThrow(
      /unsafe sink domain/,
    );
  });
});

describe("contact column list stays honest", () => {
  // A contact column missing from this list is an address that survives the seed
  // and can receive real mail. Check it against the declared schema rather than
  // trusting that someone updated it.
  it("covers every email/phone column the schema declares on the listed tables", () => {
    const declared: Record<string, string[]> = {
      users: Object.keys(schema.users),
      companies: Object.keys(schema.companies),
    };
    const covered = new Map(
      CONTACT_COLUMNS.map((c) => [
        c.table,
        new Set([...(c.emailColumns ?? []), ...(c.phoneColumns ?? [])]),
      ]),
    );

    const toSnake = (s: string): string => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    for (const [table, columns] of Object.entries(declared)) {
      const contactish = columns
        .map(toSnake)
        .filter((c) => /email|phone/.test(c))
        .sort();
      expect([...(covered.get(table) ?? [])].sort()).toEqual(contactish);
    }
  });
});

describe("staging marker", () => {
  it("is written by the seed and readable afterwards", async () => {
    await client.exec(stagingMarkerSql("prod-snapshot-2026-08-17", "2026-08-17T10:00:00.000Z"));

    const row = (
      await client.query<{ source: string }>("SELECT source FROM staging_marker WHERE id = 1")
    ).rows[0]!;
    expect(row.source).toBe("prod-snapshot-2026-08-17");
  });

  it("is replaced, not duplicated, on a re-seed", async () => {
    await client.exec(stagingMarkerSql("first", "2026-08-17T10:00:00.000Z"));
    await client.exec(stagingMarkerSql("second", "2026-08-18T10:00:00.000Z"));

    const rows = await client.query<{ source: string }>("SELECT source FROM staging_marker");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.source).toBe("second");
  });

  it("escapes a quote in the source rather than breaking the statement", async () => {
    await client.exec(stagingMarkerSql("o'brien snapshot", "2026-08-17T10:00:00.000Z"));
    const row = (await client.query<{ source: string }>("SELECT source FROM staging_marker")).rows[0]!;
    expect(row.source).toBe("o'brien snapshot");
  });
});

describe("the full seed", () => {
  it("anonymizes and marks in one transaction", async () => {
    await client.exec(
      seedSql({ sinkDomain: SINK, source: "prod-snapshot", seededAt: "2026-08-17T10:00:00.000Z" }),
    );

    const leaked = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM users WHERE email NOT LIKE '%@${SINK}'`,
    );
    expect(leaked.rows[0]!.c).toBe(0);
    const marker = await client.query<{ c: number }>("SELECT count(*)::int AS c FROM staging_marker");
    expect(marker.rows[0]!.c).toBe(1);
  });
});
