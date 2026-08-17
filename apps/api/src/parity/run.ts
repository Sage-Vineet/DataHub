import { main } from "./cli.js";

/**
 * Entry point for `pnpm --filter @datahub/api parity`.
 *
 * Exit codes are distinct because they mean different things to an operator:
 *   0 — every compared endpoint agreed (read the coverage line before acting)
 *   1 — at least one endpoint diverged
 *   2 — misconfigured (missing DATABASE_URL / origins)
 *   3 — refused to run (production target, or no staging marker)
 *
 * 3 is deliberately not folded into 1: "the harness declined to point at this
 * database" is not a parity failure, and confusing the two would send someone
 * hunting for a divergence that was never tested.
 */
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  });
