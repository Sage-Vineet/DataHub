import type { HierarchyWriter } from "./ports.js";

/**
 * The hierarchy writer, in-process.
 *
 * `hierarchy.legacy.ts` paid an HTTP hop to the route that owned
 * `chart_of_accounts`, because writing the level columns here would have made
 * this the second hierarchy writer in the system — diverging from the manual
 * grid's the moment either changed, with no audit entry and no user-modified
 * flag. That route is now a module, so the hop is unnecessary and this adapter
 * replaces it. The reason for the hop is preserved: there is still exactly one
 * writer, and this delegates to it.
 *
 * It takes a function rather than the chart-of-accounts service itself, so this
 * module still depends on nothing but its own port. The composition root
 * supplies the binding, per request, with the caller's own identity — a reviewer
 * who cannot edit an account still cannot apply a recommendation to it.
 */
export interface ApplyHierarchy {
  (
    accountId: string,
    patch: {
      levels: string[];
      movedParent: boolean;
      accountType?: string;
      statementType?: string;
    },
  ): Promise<unknown>;
}

export function createInProcessHierarchyWriter(apply: ApplyHierarchy): HierarchyWriter {
  return {
    async updateAccountHierarchy(accountId, patch, _userId) {
      // `userId` is ignored deliberately: the binding already carries the
      // caller's session, and trusting an id passed alongside it would let a
      // caller name somebody else as the editor.
      await apply(accountId, patch);
    },
  };
}
