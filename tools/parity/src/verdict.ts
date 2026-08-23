import { isComplete, type DomainCoverage } from "./coverage.js";

/**
 * Turning a run into an exit code.
 *
 * Separate from `cli.ts` because that module runs `main()` on import, so the
 * decision that gates a cutover could not otherwise be tested without starting a
 * run. It is a pure function of the summary and the coverage.
 *
 * The case that motivates it: a suite that compares NOTHING is "clean". Before
 * coverage was wired in, such a run printed `PARITY CLEAN` and exited 0, which
 * reads exactly like proof of agreement. Silence and agreement have to be
 * different answers.
 */
export interface Verdict {
  code: 0 | 1 | 3;
  /** Written to stderr. Non-fatal context the reader needs before acting. */
  warnings: string[];
  /** Written to stderr. The reason for a non-zero code. */
  errors: string[];
}

export function verdictFor(clean: boolean, coverage: ReadonlyArray<DomainCoverage>): Verdict {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!clean) return { code: 1, warnings, errors };

  const exercised = coverage.reduce((n, c) => n + c.covered, 0);
  if (coverage.length === 0 || exercised === 0) {
    errors.push(
      "Refusing to report a clean run: no comparable endpoint was exercised. " +
        "The verdict above describes an empty comparison, not agreement.",
    );
    return { code: 3, warnings, errors };
  }

  // A scenario matching no route on either side passed by not being compared.
  // Counting it as agreement is how a typo becomes evidence.
  const stale = coverage.flatMap((c) => c.unmatched);
  if (stale.length > 0) {
    errors.push(
      `${stale.length} scenario(s) matched no route on either side — stale or mistyped: ` +
        `${stale.join("; ")}. Treating this run as clean would count them as passes.`,
    );
    return { code: 1, warnings, errors };
  }

  if (!coverage.every(isComplete)) {
    // Not a failure. A sampled run is legitimate evidence for a flag flip; it is
    // not evidence for deleting a handler no scenario touched.
    warnings.push("Coverage is partial — read the coverage lines above before acting on this.");
  }

  return { code: 0, warnings, errors };
}
