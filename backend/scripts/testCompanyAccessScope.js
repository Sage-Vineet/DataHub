/**
 * Regression test for broker company scoping.
 * Run with: node backend/scripts/testCompanyAccessScope.js
 */

const assert = require("assert");
const {
  buildCompanyAssignmentSnapshot,
  getUserCompanyIds,
} = require("../src/services/userService");
const permissionService = require("../src/services/permissionService");
const { getCompanyListScopeIds } = require("../src/services/companyService");

const OWN_COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BROKER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PRIMARY_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

function assertDoesNotContain(values, blockedValue, message) {
  assert(!values.map(String).includes(String(blockedValue)), message);
}

function assertContains(values, expectedValue, message) {
  assert(values.map(String).includes(String(expectedValue)), message);
}

const broker = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "broker",
  email: "broker@example.com",
  company_id: null,
};

const snapshot = buildCompanyAssignmentSnapshot({
  user: broker,
  assignedCompanies: [{ id: OWN_COMPANY_ID, name: "Owned Company" }],
  directCompanies: [{ id: OWN_COMPANY_ID, name: "Owned Company" }],
  historicalCompanies: [{ id: OTHER_BROKER_COMPANY_ID, name: "Other Broker Company" }],
});

assert.deepStrictEqual(snapshot.company_ids, [OWN_COMPANY_ID]);
assert.deepStrictEqual(snapshot.assigned_companies.map((company) => company.id), [OWN_COMPANY_ID]);
assert.deepStrictEqual(snapshot.direct_company_ids, [OWN_COMPANY_ID]);
assert.deepStrictEqual(snapshot.historical_company_ids, [OTHER_BROKER_COMPANY_ID]);

const enrichedBroker = { ...broker, ...snapshot };

assertContains(getUserCompanyIds(enrichedBroker), OWN_COMPANY_ID, "Explicit company should remain accessible.");
assertDoesNotContain(
  getUserCompanyIds(enrichedBroker),
  OTHER_BROKER_COMPANY_ID,
  "Historical company must not be returned by getUserCompanyIds.",
);
assert(permissionService.canAccessCompany(enrichedBroker, OWN_COMPANY_ID), "Explicit company should pass permission checks.");
assert(
  !permissionService.canAccessCompany(enrichedBroker, OTHER_BROKER_COMPANY_ID),
  "Historical company must not pass permission checks.",
);

const pollutedBroker = {
  ...broker,
  direct_company_ids: [OWN_COMPANY_ID],
  company_ids: [OWN_COMPANY_ID, OTHER_BROKER_COMPANY_ID],
  assigned_companies: [{ id: OTHER_BROKER_COMPANY_ID, name: "Other Broker Company" }],
};

assert.deepStrictEqual(getCompanyListScopeIds(pollutedBroker), [OWN_COMPANY_ID]);
assert(
  !permissionService.canAccessCompany(pollutedBroker, OTHER_BROKER_COMPANY_ID),
  "direct_company_ids must override polluted assigned/company arrays.",
);

const primaryFallbackSnapshot = buildCompanyAssignmentSnapshot({
  user: { ...broker, company_id: PRIMARY_COMPANY_ID, company_name: "Primary Company" },
  assignedCompanies: [],
  directCompanies: [],
  fallbackCompanyMap: new Map([[PRIMARY_COMPANY_ID, { id: PRIMARY_COMPANY_ID, name: "Primary Company" }]]),
  historicalCompanies: [{ id: OTHER_BROKER_COMPANY_ID, name: "Other Broker Company" }],
});

assert.deepStrictEqual(primaryFallbackSnapshot.company_ids, [PRIMARY_COMPANY_ID]);
assertDoesNotContain(
  primaryFallbackSnapshot.company_ids,
  OTHER_BROKER_COMPANY_ID,
  "Historical company must not override primary company fallback.",
);

console.log("Company access scope regression tests passed.");
