import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchemaDb } from "@datahub/db";
import userService from "./userService.js";
import permissionService from "./permissionService.js";

const { loadAssignedCompaniesFromPg, _enrichFromPgAssignments } = userService;
const { canAccessCompany } = permissionService;

/**
 * A user must keep every company they are assigned to when Supabase is down.
 *
 * `attachAssignedCompanies` reads `user_companies` through Supabase. The
 * direct-Postgres fallbacks in `getUserById` / `getUserByEmail` did not: having
 * already read the user row from Postgres, they finished with
 * `_enrichFromCompanyIdOnly`, whose own docstring says it is for "when BOTH
 * Supabase and direct-Postgres are unavailable" and which derives `company_ids`
 * from `users.company_id` alone.
 *
 * So for the whole duration of any Supabase outage or quota block, a
 * multi-company user was silently reduced to one company. `canAccessCompany`
 * consults exactly that list, so the symptom is a broker getting 403 on the
 * activity log, reminders, the chart of accounts and report sources for every
 * company but one — while the in-process modules, which read the database
 * directly, behaved perfectly. An authorization downgrade triggered by an
 * unrelated dependency failing, at the moment it is hardest to diagnose.
 *
 * The SQL runs against PGlite loaded with `packages/db/schema-snapshot.sql`,
 * the real deployed schema, so the query and its joins are exercised as
 * written rather than against DDL a test invented.
 */

const BROKER = "11111111-1111-4111-8111-111111111111";
const LONER = "11111111-1111-4111-8111-111111111112";
const ACME = "22222222-2222-4222-8222-222222222221";
const NORTHWIND = "22222222-2222-4222-8222-222222222222";
const HARBOR = "22222222-2222-4222-8222-222222222223";
const STRANGER = "22222222-2222-4222-8222-222222222299";

let db;
let query;

beforeEach(async () => {
  db = await createSchemaDb();
  query = (text, params) => db.query(text, params);

  await db.exec(`
    INSERT INTO companies (id, name, industry, status, contact_email) VALUES
      ('${ACME}',      'Acme Manufacturing',   'Manufacturing', 'active', 'owner@acme.test'),
      ('${NORTHWIND}', 'Northwind Logistics',  'Logistics',     'active', 'owner@northwind.test'),
      ('${HARBOR}',    'Harbor Point Medical', 'Healthcare',    'active', 'owner@harbor.test'),
      ('${STRANGER}',  'Cardinal Foods',       'Food',          'active', 'pat@cardinal.test');

    INSERT INTO users (id, name, email, password_hash, role, company_id, status) VALUES
      ('${BROKER}', 'Blake Broker', 'broker@demo.test', 'x', 'broker', '${ACME}', 'active'),
      ('${LONER}',  'Solo Broker',  'solo@demo.test',   'x', 'broker', '${ACME}', 'active');

    -- The broker works three mandates. This is the table the fallback ignored.
    INSERT INTO user_companies (user_id, company_id) VALUES
      ('${BROKER}', '${ACME}'),
      ('${BROKER}', '${NORTHWIND}'),
      ('${BROKER}', '${HARBOR}');
  `);
});

afterEach(async () => {
  await db?.close();
});

describe("loadAssignedCompaniesFromPg", () => {
  it("returns every company the user is assigned to", async () => {
    const byUser = await loadAssignedCompaniesFromPg(query, [BROKER]);

    const ids = byUser.get(BROKER).map((c) => c.id).sort();
    expect(ids).toEqual([ACME, HARBOR, NORTHWIND].sort());
  });

  it("carries the company name and contact email the enrichment needs", async () => {
    const byUser = await loadAssignedCompaniesFromPg(query, [BROKER]);

    const acme = byUser.get(BROKER).find((c) => c.id === ACME);
    expect(acme).toEqual({
      id: ACME,
      name: "Acme Manufacturing",
      contact_email: "owner@acme.test",
    });
  });

  it("keeps users separate when several are loaded at once", async () => {
    await db.exec(`INSERT INTO user_companies (user_id, company_id) VALUES ('${LONER}', '${NORTHWIND}');`);

    const byUser = await loadAssignedCompaniesFromPg(query, [BROKER, LONER]);

    expect(byUser.get(BROKER)).toHaveLength(3);
    expect(byUser.get(LONER).map((c) => c.id)).toEqual([NORTHWIND]);
  });

  it("returns an empty map for a user with no assignments", async () => {
    const byUser = await loadAssignedCompaniesFromPg(query, [LONER]);
    expect(byUser.get(LONER)).toBeUndefined();
  });

  it("does not query at all for an empty id list", async () => {
    let called = false;
    const spy = (...args) => { called = true; return query(...args); };

    const byUser = await loadAssignedCompaniesFromPg(spy, []);

    expect(called).toBe(false);
    expect(byUser.size).toBe(0);
  });
});

describe("_enrichFromPgAssignments", () => {
  const base = {
    id: BROKER, name: "Blake Broker", email: "broker@demo.test",
    role: "broker", company_id: ACME, company_name: "Acme Manufacturing",
  };

  it("exposes all assigned companies to canAccessCompany", async () => {
    const byUser = await loadAssignedCompaniesFromPg(query, [BROKER]);

    const user = _enrichFromPgAssignments(base, byUser.get(BROKER));

    // The primary company was never the broken case; the other two were.
    expect(canAccessCompany(user, ACME)).toBe(true);
    expect(canAccessCompany(user, NORTHWIND)).toBe(true);
    expect(canAccessCompany(user, HARBOR)).toBe(true);
  });

  it("still denies a company the user is not assigned to", async () => {
    const byUser = await loadAssignedCompaniesFromPg(query, [BROKER]);

    const user = _enrichFromPgAssignments(base, byUser.get(BROKER));

    // The fix widens access to what the database says — not to everything.
    expect(canAccessCompany(user, STRANGER)).toBe(false);
  });

  it("keeps the primary company when user_companies has no row for it", () => {
    // The post-migration shape `_enrichFromCompanyIdOnly` was written for:
    // company_id is set, the assignment table is not yet populated. Reading the
    // assignment table must never narrow access below what the column grants.
    const user = _enrichFromPgAssignments(base, []);

    expect(user.company_ids).toEqual([ACME]);
    expect(canAccessCompany(user, ACME)).toBe(true);
  });

  it("does not duplicate the primary company when it is also assigned", async () => {
    const byUser = await loadAssignedCompaniesFromPg(query, [BROKER]);

    const user = _enrichFromPgAssignments(base, byUser.get(BROKER));

    expect(user.company_ids.filter((id) => id === ACME)).toHaveLength(1);
  });

  it("reports direct assignments separately from the primary-column fallback", () => {
    const user = _enrichFromPgAssignments(base, []);

    // direct_company_ids is what the Deal Team page filters on: companies from
    // user_companies rows only. A company present solely because of the
    // users.company_id fallback is not a direct assignment.
    expect(user.direct_company_ids).toEqual([]);
    expect(user.company_ids).toEqual([ACME]);
  });

  it("treats a buyer whose email is the company contact as client-side", async () => {
    const sellerBase = {
      id: LONER, name: "Grace Lin", email: "owner@harbor.test",
      role: "buyer", company_id: HARBOR, company_name: "Harbor Point Medical",
    };
    await db.exec(`INSERT INTO user_companies (user_id, company_id) VALUES ('${LONER}', '${HARBOR}');`);
    const byUser = await loadAssignedCompaniesFromPg(query, [LONER]);

    const user = _enrichFromPgAssignments(sellerBase, byUser.get(LONER));

    // Seller detection reads contact_email off the assigned company, which is
    // why the loader selects that column rather than just the id.
    expect(user.effective_role).toBe("client");
  });

  it("leaves an ordinary buyer on the buy side", async () => {
    const buyerBase = {
      id: LONER, name: "Ken Tanaka", email: "buyer@meridian.test",
      role: "buyer", company_id: HARBOR, company_name: "Harbor Point Medical",
    };
    await db.exec(`INSERT INTO user_companies (user_id, company_id) VALUES ('${LONER}', '${HARBOR}');`);
    const byUser = await loadAssignedCompaniesFromPg(query, [LONER]);

    const user = _enrichFromPgAssignments(buyerBase, byUser.get(LONER));

    expect(user.effective_role).toBe("user");
  });
});
