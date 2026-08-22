import type { HierarchyWriter } from "./ports.js";

/**
 * The hierarchy writer, over the legacy route that owns account hierarchy.
 *
 * Legacy serves `PATCH /key-reports/chart-of-accounts/:accountId`, which calls
 * `chartOfAccountsService.updateAccountHierarchy` — the SAME function the manual
 * "Edit Chart of Accounts" grid uses. It writes `level_1..15`, `hierarchy_path`
 * and `base_account`, optionally `account_type`/`statement_type`, appends an
 * audit entry, and marks the row user-modified. It touches no balance and no GL
 * mapping.
 *
 * ## Why this goes over HTTP rather than writing the columns directly
 *
 * Writing them from here would be trivial and would be the wrong thing: it would
 * make this the second hierarchy writer in the system, silently diverging from
 * the grid's the moment either changes — no audit entry, no user-modified flag,
 * no `hierarchy_path` rebuild. The rule the ported design rests on is that there
 * is exactly one, so this pays a network hop to keep that true.
 *
 * When the chart of accounts moves in-process, replace this adapter with a
 * direct call to whatever owns it then. Nothing else has to change: the module
 * depends on the port, not on this.
 *
 * ## Authorization
 *
 * The caller's own credentials are forwarded rather than any service identity.
 * Legacy re-checks company access on that route, so a reviewer who cannot edit
 * the account cannot apply a recommendation to it either — which would be a
 * privilege escalation dressed up as a convenience, since the review UI is
 * reachable by anyone who can see the version.
 */
export interface LegacyHierarchyWriterOptions {
  /** Where legacy is reachable, e.g. `http://legacy:4000`. */
  origin: string;
  /**
   * The caller's credentials for this request. The bridge mints the header the
   * gateway forwards, so this is the same identity legacy would have seen had
   * the request gone straight through.
   */
  authorization?: string | undefined;
  cookie?: string | undefined;
  fetchImpl?: typeof fetch;
}

export function createLegacyHierarchyWriter(
  opts: LegacyHierarchyWriterOptions,
): HierarchyWriter {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async updateAccountHierarchy(accountId, patch, _userId) {
      const url = `${opts.origin.replace(/\/$/, "")}/key-reports/chart-of-accounts/${encodeURIComponent(accountId)}`;
      const res = await doFetch(url, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(opts.authorization ? { authorization: opts.authorization } : {}),
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
        // `userId` is deliberately not sent: legacy takes the actor from the
        // authenticated request, and a body that could name a different one
        // would be a way to forge an audit entry.
        body: JSON.stringify(patch),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `legacy hierarchy update failed (${res.status}): ${detail.slice(0, 300)}`,
        );
      }
    },
  };
}
