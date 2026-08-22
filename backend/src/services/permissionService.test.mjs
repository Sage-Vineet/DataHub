import { describe, expect, it } from "vitest";
import permissionService from "./permissionService.js";

const {
  isBroker,
  isAdmin,
  normalizeCompanyIds,
  canAccessCompany,
  canAccessRequest,
  filterRequestsForUser,
} = permissionService;

/**
 * Every authorization decision the legacy backend makes goes through this file,
 * and it had no tests.
 *
 * That matters more than its 78 lines suggest. Legacy still owns most of the
 * financial surface during the cutover, so this is what stands between one
 * client's diligence data and another's. It is also pure — no database, no
 * Supabase, no clock — so there is no excuse for it being untested, and a
 * regression here fails silently in the direction that matters: a check that
 * wrongly returns `true` looks exactly like a working page.
 *
 * The cases below are written as claims about who may see what, not as coverage
 * of branches. Where a branch exists only because of a data-shape quirk — a
 * `visible` column that is sometimes `0` and sometimes `false`, ids that are
 * sometimes numbers — that quirk is the thing being asserted, because it is the
 * thing that will change underneath this code.
 */

const ACME = "a0000000-0000-4000-8000-000000000001";
const NORTHWIND = "a0000000-0000-4000-8000-000000000002";
const CARDINAL = "a0000000-0000-4000-8000-000000000003";

const broker = { id: "u-broker", role: "broker", company_id: ACME, company_ids: [ACME, NORTHWIND] };
const admin = { id: "u-admin", role: "admin", company_id: null, company_ids: [] };
const client = { id: "u-client", role: "buyer", effective_role: "client", company_id: ACME, company_ids: [ACME] };

/** A request in the shape the requests table returns it. */
function request(overrides = {}) {
  return {
    id: "r-1",
    company_id: ACME,
    approval_status: "approved",
    visible: true,
    assigned_to: null,
    created_by: "u-broker",
    ...overrides,
  };
}

describe("isBroker / isAdmin", () => {
  it("counts an admin as a broker, because admins do everything brokers do", () => {
    expect(isBroker(admin)).toBe(true);
    expect(isBroker(broker)).toBe(true);
  });

  it("does not count a buyer as a broker", () => {
    expect(isBroker(client)).toBe(false);
  });

  it("does not count a broker as an admin", () => {
    // The asymmetry is the point: isBroker is a superset, isAdmin is not.
    expect(isAdmin(broker)).toBe(false);
    expect(isAdmin(admin)).toBe(true);
  });

  it("is case-insensitive about the stored role", () => {
    // Roles arrive from several writers — legacy inserts, the Better Auth
    // backfill, and hand-edited rows — so casing is not guaranteed.
    expect(isBroker({ role: "BROKER" })).toBe(true);
    expect(isAdmin({ role: "Admin" })).toBe(true);
  });

  it("treats a missing user or role as not privileged", () => {
    for (const u of [null, undefined, {}, { role: null }, { role: "" }]) {
      expect(isBroker(u)).toBe(false);
      expect(isAdmin(u)).toBe(false);
    }
  });
});

describe("normalizeCompanyIds", () => {
  it("merges all three places a company association can be recorded", () => {
    // company_ids, assigned_companies[].id and the primary company_id column
    // are populated by different code paths; a user may have any combination.
    const ids = normalizeCompanyIds({
      company_ids: [ACME],
      assigned_companies: [{ id: NORTHWIND }],
      company_id: CARDINAL,
    });
    expect([...ids].sort()).toEqual([ACME, NORTHWIND, CARDINAL].sort());
  });

  it("deduplicates a company recorded in more than one of them", () => {
    const ids = normalizeCompanyIds({
      company_ids: [ACME],
      assigned_companies: [{ id: ACME }],
      company_id: ACME,
    });
    expect(ids).toEqual([ACME]);
  });

  it("stringifies, so a numeric id still matches a string one", () => {
    expect(normalizeCompanyIds({ company_ids: [42], company_id: 7 })).toEqual(["42", "7"]);
  });

  it("drops null and undefined entries rather than emitting them", () => {
    // A user with no primary company yields `undefined` here; leaving it in
    // would make `includes(String(undefined))` a live comparison.
    expect(normalizeCompanyIds({ company_ids: [ACME, null], company_id: undefined })).toEqual([ACME]);
  });

  it("returns an empty list for a user with no associations at all", () => {
    expect(normalizeCompanyIds({})).toEqual([]);
    expect(normalizeCompanyIds(null)).toEqual([]);
  });
});

describe("canAccessCompany", () => {
  it("lets an admin reach any company, including one they are not assigned to", () => {
    expect(canAccessCompany(admin, CARDINAL)).toBe(true);
  });

  it("lets a broker reach every assigned company, not only their primary one", () => {
    expect(canAccessCompany(broker, ACME)).toBe(true);
    expect(canAccessCompany(broker, NORTHWIND)).toBe(true);
  });

  it("denies a company nobody assigned them to", () => {
    expect(canAccessCompany(broker, CARDINAL)).toBe(false);
    expect(canAccessCompany(client, NORTHWIND)).toBe(false);
  });

  it("falls back to the primary column when company_ids is empty or stale", () => {
    // This is the path that keeps a user working when the assignment list has
    // not been backfilled yet. It must not be the ONLY path — that was the
    // Supabase-outage defect fixed in userService.
    expect(canAccessCompany({ role: "broker", company_id: ACME, company_ids: [] }, ACME)).toBe(true);
  });

  it("denies when either side is missing", () => {
    expect(canAccessCompany(null, ACME)).toBe(false);
    expect(canAccessCompany(broker, null)).toBe(false);
    expect(canAccessCompany(broker, undefined)).toBe(false);
  });
});

describe("canAccessRequest", () => {
  it("refuses anything belonging to another company, whatever the role", () => {
    // Cross-tenant denial is checked before any role logic, so a broker gets no
    // more reach than a buyer here.
    expect(canAccessRequest(broker, request({ company_id: CARDINAL }))).toBe(false);
    expect(canAccessRequest(client, request({ company_id: CARDINAL }))).toBe(false);
  });

  it("lets a broker see a request their client cannot", () => {
    const unapproved = request({ approval_status: "pending" });
    expect(canAccessRequest(broker, unapproved)).toBe(true);
    expect(canAccessRequest(client, unapproved)).toBe(false);
  });

  it("hides an unapproved or invisible request from a client", () => {
    expect(canAccessRequest(client, request({ approval_status: "pending" }))).toBe(false);
    expect(canAccessRequest(client, request({ visible: false }))).toBe(false);
  });

  it("treats visible = 0 as hidden, not as merely falsy", () => {
    // The column is boolean in Postgres and integer through some legacy writers.
    // Both spellings must hide the row; only an explicit check does that.
    expect(canAccessRequest(client, request({ visible: 0 }))).toBe(false);
  });

  it("shows an ordinary client every approved, visible request", () => {
    expect(canAccessRequest(client, request())).toBe(true);
  });

  describe("restricted client team members", () => {
    const teamMember = { ...client, id: "u-team", sub_role: "client_team_member" };
    const accountant = { ...client, id: "u-acct", sub_role: "client_accountant" };

    it("shows them a request assigned to them", () => {
      expect(canAccessRequest(teamMember, request({ assigned_to: "u-team" }))).toBe(true);
      expect(canAccessRequest(accountant, request({ assigned_to: "u-acct" }))).toBe(true);
    });

    it("shows them an unassigned request", () => {
      expect(canAccessRequest(teamMember, request({ assigned_to: null }))).toBe(true);
    });

    it("hides a request assigned to a colleague", () => {
      expect(canAccessRequest(teamMember, request({ assigned_to: "u-someone-else" }))).toBe(false);
    });

    it("compares ids as strings, so a numeric assignee still matches", () => {
      const numeric = { ...client, id: 5, sub_role: "client_team_member" };
      expect(canAccessRequest(numeric, request({ assigned_to: 5 }))).toBe(true);
    });

    it("does not restrict a company_owner", () => {
      const owner = { ...client, id: "u-owner", sub_role: "company_owner" };
      expect(canAccessRequest(owner, request({ assigned_to: "u-someone-else" }))).toBe(true);
    });
  });

  describe("users who are neither broker nor client", () => {
    // A buyer with no effective_role — the default branch. They see approved
    // work, plus anything they raised themselves even before it is approved.
    const buyer = { id: "u-buyer", role: "buyer", company_id: ACME, company_ids: [ACME] };

    it("sees an approved request", () => {
      expect(canAccessRequest(buyer, request())).toBe(true);
    });

    it("sees their own unapproved request", () => {
      expect(canAccessRequest(buyer, request({ approval_status: "pending", created_by: "u-buyer" }))).toBe(true);
    });

    it("does not see someone else's unapproved request", () => {
      expect(canAccessRequest(buyer, request({ approval_status: "pending", created_by: "u-other" }))).toBe(false);
    });
  });

  it("denies when either side is missing", () => {
    expect(canAccessRequest(null, request())).toBe(false);
    expect(canAccessRequest(broker, null)).toBe(false);
  });
});

describe("filterRequestsForUser", () => {
  const rows = [
    request({ id: "acme-approved", company_id: ACME }),
    request({ id: "acme-pending", company_id: ACME, approval_status: "pending" }),
    request({ id: "northwind", company_id: NORTHWIND }),
    request({ id: "cardinal", company_id: CARDINAL }),
  ];
  const ids = (list) => list.map((r) => r.id);

  it("gives an admin everything, unfiltered", () => {
    expect(ids(filterRequestsForUser(admin, rows))).toEqual(
      ["acme-approved", "acme-pending", "northwind", "cardinal"],
    );
  });

  it("scopes a broker to their assigned companies", () => {
    // Including the pending one: approval gates the client's view, not the
    // broker's — the broker is who approves it.
    expect(ids(filterRequestsForUser(broker, rows))).toEqual(
      ["acme-approved", "acme-pending", "northwind"],
    );
  });

  it("gives a client only approved, visible rows", () => {
    const visible = ids(filterRequestsForUser(client, rows));
    expect(visible).not.toContain("acme-pending");
    expect(visible).toContain("acme-approved");
  });

  it("narrows a restricted team member to their own assignments", () => {
    const teamMember = { ...client, id: "u-team", sub_role: "client_team_member" };
    const mine = request({ id: "mine", assigned_to: "u-team" });
    const theirs = request({ id: "theirs", assigned_to: "u-other" });
    const unassigned = request({ id: "unassigned" });

    expect(ids(filterRequestsForUser(teamMember, [mine, theirs, unassigned])))
      .toEqual(["mine", "unassigned"]);
  });

  it("gives a plain buyer approved rows plus their own", () => {
    const buyer = { id: "u-buyer", role: "buyer", company_id: ACME, company_ids: [ACME] };
    const own = request({ id: "own", approval_status: "pending", created_by: "u-buyer" });
    const other = request({ id: "other", approval_status: "pending", created_by: "u-else" });

    expect(ids(filterRequestsForUser(buyer, [own, other, rows[0]])))
      .toEqual(["own", "acme-approved"]);
  });

  it("returns nothing rather than throwing for an empty list", () => {
    expect(filterRequestsForUser(broker, [])).toEqual([]);
    expect(filterRequestsForUser(client, [])).toEqual([]);
  });

  // filterRequestsForUser does NOT re-check company scope for clients or plain
  // buyers — it filters on approval and assignment only, and relies on the
  // caller having scoped the query already.
  //
  // Its one caller does, correctly: `controllers/requests.js:listRequests`
  // guards with `canAccessCompany` and then queries
  // `listRequestsByCompany(req.params.id)`, so the list reaching this function
  // is single-company by construction. There is no leak today.
  //
  // Asserted anyway, because the safety lives entirely in the caller and
  // nothing in this function's signature says so. A second caller passing an
  // unscoped list is the shape the next cross-tenant bug would take, and this
  // test is what would fail when someone changes the filtering here believing
  // it is already tenant-safe.
  it("does not itself scope a client to their company (the caller must)", () => {
    const leaked = ids(filterRequestsForUser(client, rows));
    expect(leaked).toContain("northwind");
    expect(leaked).toContain("cardinal");
  });
});
