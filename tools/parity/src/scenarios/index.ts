import type { Fixtures } from "../config.js";
import type { Scenario } from "../scenario.js";

/**
 * The parity suites, one per domain, each scenario carrying the delta-spec
 * requirement it exercises (the delta specs under `openspec/changes/<change>/specs/`).
 *
 * Coverage bias is deliberate. The suites lean on **reads, tenant boundaries and
 * error paths**, because those need no seeded mutation, are safe to replay
 * against both upstreams, and are where a rewrite most often diverges: an
 * authorisation check that returns 404 instead of 403, a filter whose query
 * parameter was renamed, a list that lost its ordering. Write flows are included
 * but marked `mutating`, and the runner skips them unless explicitly allowed —
 * replaying them hits BOTH upstreams and therefore writes twice to the shared
 * database.
 *
 * A scenario earns its place by being able to FAIL for a real reason. Assertions
 * that merely restate the implementation are omitted.
 */

function companies(f: Fixtures): Scenario[] {
  return [
    {
      id: "list-scoped",
      domain: "companies",
      spec: "companies-domain > Tenant-scoped company listing > Non-admin is scoped",
      persona: "broker",
      request: { method: "GET", path: "/companies" },
      // No ORDER BY is guaranteed by either side, so compare as a set.
      normalize: { sortArraysBy: { "": "name", "$": "name" } },
    },
    {
      id: "list-admin-sees-all",
      domain: "companies",
      spec: "companies-domain > Tenant-scoped company listing > Admin sees all",
      persona: "admin",
      request: { method: "GET", path: "/companies" },
      normalize: { sortArraysBy: { "": "name", "$": "name" } },
    },
    {
      id: "read-with-stats",
      domain: "companies",
      spec: "companies-domain > Read a company with stats > Authorized read",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.companyId}` },
    },
    {
      id: "cross-tenant-read-denied",
      domain: "companies",
      spec: "companies-domain > Read a company with stats > Cross-tenant read denied",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.foreignCompanyId}` },
    },
    {
      id: "anonymous-rejected",
      domain: "companies",
      spec: "companies-domain > Multi-tenant access is enforced everywhere > Consistent guard",
      persona: "anonymous",
      request: { method: "GET", path: "/companies" },
      // Both sides agreeing on 200 here would be a security regression, so this
      // asserts absolutely rather than only comparing.
      expectStatus: 401,
    },
    {
      id: "unprivileged-create-rejected",
      domain: "companies",
      spec: "companies-domain > Create a company > Non-privileged create rejected",
      persona: "client",
      request: {
        method: "POST",
        path: "/companies",
        body: { name: "Parity Probe Co", industry: "Testing" },
      },
      // Rejected before it writes, so this is safe to replay.
      expectStatus: 403,
    },
  ];
}

function users(f: Fixtures): Scenario[] {
  const scenarios: Scenario[] = [
    {
      id: "list-scoped",
      domain: "users",
      spec: "users-domain > Tenant-scoped user visibility > Broker sees users in their companies",
      persona: "broker",
      request: { method: "GET", path: "/users" },
      normalize: { sortArraysBy: { "": "email", "$": "email" } },
    },
    {
      id: "list-admin-sees-all",
      domain: "users",
      spec: "users-domain > Tenant-scoped user visibility > Admin sees all",
      persona: "admin",
      request: { method: "GET", path: "/users" },
      normalize: { sortArraysBy: { "": "email", "$": "email" } },
    },
    {
      id: "find-by-email-unknown",
      domain: "users",
      spec: "users-domain > Tenant-scoped user visibility > Broker sees users in their companies",
      persona: "broker",
      request: {
        method: "GET",
        path: "/users/find-by-email",
        query: { email: "definitely-not-a-user@parity.invalid" },
      },
    },
    {
      id: "anonymous-rejected",
      domain: "users",
      spec: "users-domain > Tenant-scoped user visibility > Broker sees users in their companies",
      persona: "anonymous",
      request: { method: "GET", path: "/users" },
      expectStatus: 401,
    },
    {
      id: "broker-cannot-create-admin",
      domain: "users",
      spec: "users-domain > Role/sub-role-gated creation > Broker cannot create an admin",
      persona: "broker",
      request: {
        method: "POST",
        path: "/users",
        body: {
          email: "parity-probe-admin@parity.invalid",
          name: "Parity Probe",
          role: "admin",
          password: "parity-probe-password",
        },
      },
      expectStatus: 403,
    },
  ];
  if (f.userId) {
    scenarios.push({
      id: "read-user",
      domain: "users",
      spec: "users-domain > Effective-role computation > Client sub-roles resolve to client",
      persona: "broker",
      request: { method: "GET", path: `/users/${f.userId}` },
    });
  }
  return scenarios;
}

function folders(f: Fixtures): Scenario[] {
  const scenarios: Scenario[] = [
    {
      id: "tree",
      domain: "folders",
      spec: "folders-domain > Tenant-scoped folder listing and tree > Authorized tree read",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.companyId}/folders/tree` },
      normalize: { sortArraysBy: { "**.children": "name", "": "name", "$": "name" } },
    },
    {
      /**
       * The archived filter, sent the way the SPA sends it
       * (`apps/web/src/lib/api.js` builds `?includeArchived=true`). Legacy reads
       * `req.query.includeArchived`; a module reading a differently-cased name
       * would silently return the unfiltered list — a difference invisible in a
       * unit test that calls the module with its own parameter name.
       */
      id: "tree-include-archived",
      domain: "folders",
      spec: "folders-domain > Tenant-scoped folder listing and tree > Archived filter",
      persona: "broker",
      request: {
        method: "GET",
        path: `/companies/${f.companyId}/folders/tree`,
        query: { includeArchived: "true" },
      },
      normalize: { sortArraysBy: { "**.children": "name", "": "name", "$": "name" } },
    },
    {
      id: "list",
      domain: "folders",
      spec: "folders-domain > Tenant-scoped folder listing and tree > Authorized tree read",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.companyId}/folders` },
      normalize: { sortArraysBy: { "": "name", "$": "name" } },
    },
    {
      id: "cross-tenant-denied",
      domain: "folders",
      spec: "folders-domain > Tenant-scoped folder listing and tree > Cross-tenant denied",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.foreignCompanyId}/folders` },
    },
    {
      id: "anonymous-rejected",
      domain: "folders",
      spec: "folders-domain > Per-folder access grants > Only privileged users manage access",
      persona: "anonymous",
      request: { method: "GET", path: `/companies/${f.companyId}/folders` },
      expectStatus: 401,
    },
  ];
  if (f.folderId) {
    scenarios.push({
      id: "access-list",
      domain: "folders",
      spec: "folders-domain > Per-folder access grants > Grant to a user",
      persona: "broker",
      request: { method: "GET", path: `/folders/${f.folderId}/access` },
      normalize: { sortArraysBy: { "": "id", "$": "id" } },
    });
  }
  return scenarios;
}

function uploads(f: Fixtures): Scenario[] {
  const scenarios: Scenario[] = [
    {
      id: "unknown-upload",
      domain: "uploads",
      spec: "uploads-domain > Store and stream a file blob > Unknown upload",
      persona: "broker",
      request: { method: "GET", path: "/uploads/00000000-0000-0000-0000-000000000000/content" },
    },
  ];
  if (f.folderId) {
    scenarios.push(
      {
        id: "list-documents",
        domain: "uploads",
        spec: "uploads-domain > Folder-scoped documents > Add and list",
        persona: "broker",
        request: { method: "GET", path: `/folders/${f.folderId}/documents` },
        normalize: { sortArraysBy: { "": "file_name", "$": "file_name" } },
      },
      {
        id: "list-documents-include-archived",
        domain: "uploads",
        spec: "uploads-domain > Archive and delete documents > Archive then restore",
        persona: "broker",
        request: {
          method: "GET",
          path: `/folders/${f.folderId}/documents`,
          query: { includeArchived: "true" },
        },
        normalize: { sortArraysBy: { "": "file_name", "$": "file_name" } },
      },
    );
  }
  return scenarios;
}

function requests(f: Fixtures): Scenario[] {
  const scenarios: Scenario[] = [
    {
      id: "list",
      domain: "requests",
      spec: "requests-domain > Tenant-scoped requests > Cross-tenant denied",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.companyId}/requests` },
      normalize: { sortArraysBy: { "": "title", "$": "title" } },
    },
    {
      id: "cross-tenant-denied",
      domain: "requests",
      spec: "requests-domain > Tenant-scoped requests > Cross-tenant denied",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.foreignCompanyId}/requests` },
    },
    {
      id: "invalid-create-rejected",
      domain: "requests",
      spec: "requests-domain > Validated request creation > Invalid create rejected",
      persona: "broker",
      request: {
        method: "POST",
        path: `/companies/${f.companyId}/requests`,
        // Invalid on purpose: rejected by validation, so nothing is written.
        body: { title: "", priority: "not-a-priority" },
      },
      expectStatus: 400,
    },
  ];
  if (f.requestId) {
    scenarios.push(
      {
        id: "read",
        domain: "requests",
        spec: "requests-domain > Tenant-scoped requests > Cross-tenant denied",
        persona: "broker",
        request: { method: "GET", path: `/requests/${f.requestId}` },
      },
      {
        id: "narrative",
        domain: "requests",
        spec: "requests-domain > Narrative, reminders, and document links > Narrative upsert",
        persona: "broker",
        request: { method: "GET", path: `/requests/${f.requestId}/narrative` },
      },
      {
        id: "documents",
        domain: "requests",
        spec: "requests-domain > Narrative, reminders, and document links > Document link",
        persona: "broker",
        request: { method: "GET", path: `/requests/${f.requestId}/documents` },
        normalize: { sortArraysBy: { "": "id", "$": "id" } },
      },
    );
  }
  return scenarios;
}

function messages(f: Fixtures): Scenario[] {
  const scenarios: Scenario[] = [
    {
      id: "company-conversation",
      domain: "messages",
      spec: "messages-domain > Company conversation > Post and read",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.companyId}/messages` },
      normalize: { sortArraysBy: { "": "created_at", "$": "created_at" } },
    },
    {
      id: "cross-tenant-denied",
      domain: "messages",
      spec: "messages-domain > Company conversation > Cross-tenant denied",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.foreignCompanyId}/messages` },
    },
    {
      id: "my-groups",
      domain: "messages",
      spec: "messages-domain > Message groups and membership > Members only",
      persona: "broker",
      request: { method: "GET", path: "/my-groups" },
      normalize: { sortArraysBy: { "": "name", "$": "name" } },
    },
    {
      id: "company-groups",
      domain: "messages",
      spec: "messages-domain > Message groups and membership > Manage membership",
      persona: "broker",
      request: { method: "GET", path: `/companies/${f.companyId}/message-groups` },
      normalize: { sortArraysBy: { "": "name", "$": "name" } },
    },
  ];
  if (f.recipientUserId) {
    scenarios.push({
      id: "direct-messages",
      domain: "messages",
      spec: "messages-domain > Direct messages > Symmetric conversation",
      persona: "broker",
      request: {
        method: "GET",
        path: `/companies/${f.companyId}/direct-messages/${f.recipientUserId}`,
      },
      normalize: { sortArraysBy: { "": "created_at", "$": "created_at" } },
    });
  }
  return scenarios;
}

function reports(f: Fixtures): Scenario[] {
  const scenarios: Scenario[] = [
    {
      id: "list-versions",
      domain: "reports",
      spec: "reports-domain > Tenant-scoped version lifecycle > Create and list",
      persona: "broker",
      request: {
        method: "GET",
        path: "/key-reports/versions",
        query: { company_id: f.companyId },
      },
      normalize: { sortArraysBy: { "": "version_number", "$": "version_number" } },
    },
    {
      id: "cross-tenant-denied",
      domain: "reports",
      spec: "reports-domain > Tenant-scoped version lifecycle > Cross-tenant denied",
      persona: "broker",
      request: {
        method: "GET",
        path: "/key-reports/versions",
        query: { company_id: f.foreignCompanyId },
      },
    },
  ];
  if (f.reportVersionId) {
    scenarios.push({
      /**
       * The decomposition boundary itself (reports-domain D5): the GL sync stays
       * on legacy behind `ReportSyncPort`. Legacy answers it for real; the module
       * returns 501. That difference is EXPECTED and the point of running it is
       * to see it stay confined to this route — if other report routes start
       * differing too, the boundary has moved without anyone deciding to move it.
       *
       * The path must be one legacy ACTUALLY serves, or the expected difference
       * never materialises: this previously pointed at `/key-reports/chart-of-accounts`,
       * which neither side serves, so both returned the same 404 and the scenario
       * reported "match" while proving nothing about the boundary. Legacy serves
       * chart-of-accounts under `/key-reports/versions/:versionId/...`, so the
       * scenario needs the version fixture and moves under this guard.
       */
      id: "sync-is-deferred-to-legacy",
      domain: "reports",
      spec: "reports-domain > Deferred GL sync > Sync not yet migrated",
      persona: "broker",
      request: {
        method: "GET",
        path: `/key-reports/versions/${f.reportVersionId}/chart-of-accounts`,
      },
    });
    scenarios.push({
      id: "read-version",
      domain: "reports",
      spec: "reports-domain > Duplicate a version > Duplicate",
      persona: "broker",
      request: { method: "GET", path: `/key-reports/versions/${f.reportVersionId}` },
    });
  }
  return scenarios;
}

function auth(_f: Fixtures): Scenario[] {
  return [
    {
      id: "me",
      domain: "auth",
      spec: "adopt-better-auth > Session token issuance and verification > Valid session is accepted",
      persona: "broker",
      request: { method: "GET", path: "/auth/me" },
    },
    {
      id: "me-anonymous",
      domain: "auth",
      spec:
        "adopt-better-auth > Session token issuance and verification > Forged or tampered session is rejected",
      persona: "anonymous",
      request: { method: "GET", path: "/auth/me" },
      expectStatus: 401,
    },
    {
      id: "me-forged-token",
      domain: "auth",
      spec:
        "adopt-better-auth > Session token issuance and verification > Forged or tampered session is rejected",
      persona: "anonymous",
      request: {
        method: "GET",
        path: "/auth/me",
        headers: { authorization: "Bearer not.a.real.token" },
      },
      expectStatus: 401,
    },
    {
      id: "login-wrong-password",
      domain: "auth",
      spec: "adopt-better-auth > Credential migration parity > Existing bcrypt credential logs in unchanged",
      persona: "anonymous",
      request: {
        method: "POST",
        path: "/auth/login",
        body: { email: "parity-probe@parity.invalid", password: "definitely-wrong" },
      },
    },
    {
      id: "forgot-password-is-enumeration-safe",
      domain: "auth",
      spec: "adopt-better-auth > Credential migration parity > Existing bcrypt credential logs in unchanged",
      persona: "anonymous",
      request: {
        method: "POST",
        path: "/auth/forgot-password",
        body: { email: "definitely-not-a-user@parity.invalid" },
      },
    },
  ];
}

/** Build every scenario for the given environment. */
export function buildScenarios(fixtures: Fixtures): Scenario[] {
  return [
    ...auth(fixtures),
    ...companies(fixtures),
    ...users(fixtures),
    ...folders(fixtures),
    ...uploads(fixtures),
    ...requests(fixtures),
    ...messages(fixtures),
    ...reports(fixtures),
  ];
}
