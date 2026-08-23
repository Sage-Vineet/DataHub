# Cutover flip criteria

> Status: corrected 2026-08-22. Much of what follows had described the harness as
> designed rather than as built — the target refusals and the coverage number were
> written but never wired into the CLI, and this document asserted both were live.
> They are wired now, and the identifiers below have been checked against the code.
> Tool: `pnpm --filter @datahub/parity parity -- --config <path>`
> Spec: `openspec/changes/staging-parity-harness/`

Two decisions get made per domain, and they are **not the same decision**:

1. **Flip** — point a route-group at the module. Reversible: turn the flag off.
2. **Delete** — remove the legacy handler. **Irreversible**, and the only step in
   the whole program that is.

A green parity report authorizes the first. It does not, by itself, authorize the
second.

## Before flipping

- [ ] Parity run against a **marked staging target** seeded from a production
      snapshot (the harness refuses any other target).
- [ ] **All compared endpoints pass.**
- [ ] **Coverage read, not just the verdict.** The report prints
      `Coverage: N of M comparable endpoints exercised` above the verdict, and lists
      each uncovered route. If N < M the run sampled the surface. The fixes:
      - `uncovered: METHOD /path` → no declared scenario exercises it. Add one in
        `tools/parity/src/scenarios/`, or accept the gap in writing.
      - a write-path gap → re-run with `--allow-mutating` (which also requires
        `PARITY_DATABASE_URL`, so the staging marker can be checked first).
      - a fixture gap → add real ids from the snapshot to `fixtures` in the config.
      - `also exercised: … (module-only endpoint)` → additive by design, not a gap.
      - `NO MATCHING ROUTE: …` → a stale or mistyped scenario. This **fails** the
        run, because a scenario that matched nothing was never compared and must
        not be counted as a pass.
- [ ] **Semantic invariants declared** for endpoints where shape equality is weak
      evidence. Two lists of different lengths have identical shapes; only an
      invariant catches that.
- [ ] Schema drift reconciled against the committed baseline, with **no new
      breaking drift** (a declared column the database lacks will fail at runtime).

## Before deleting a legacy handler

Everything above, plus:

- [ ] The domain has served **production** traffic through the module for the
      agreed soak window.
- [ ] The **rollback path has been exercised deliberately** — flag off, legacy
      confirmed serving, verified by request. Not inferred from a clean dashboard:
      an untested rollback is a rollback that does not exist.
- [ ] Coverage was **complete** (`compared == comparable`) for that domain, or the
      gaps are individually justified in writing. Deleting the handler behind an
      endpoint parity never exercised is the specific mistake this document exists
      to prevent.
- [ ] The machine-readable report (`--json`) is attached to the cutover change, so
      the evidence the decision rested on is recoverable later.
- [ ] The deletion is a **separate, revertable commit**.

## Required environment

| Variable | Why |
|---|---|
| `PARITY_PRODUCTION_HOSTS` | Comma-separated hosts that must never be a target. **Required**: with nothing to check against, the run is refused rather than assumed safe. |
| `PARITY_DATABASE_URL` | The target database, read to confirm the `staging_marker` row the seed writes. Required for `--allow-mutating`; without it, mutating runs are refused. |

## What the harness does not tell you

- **That the request set is representative.** It compares the routes both engines
  claim, with the fixtures you supplied. A route with a thin fixture is compared
  thinly.
- **That production will behave like staging.** Different secrets, scale, and
  integrations. The canary step exists for this and is not replaced by a green
  report.
- **Anything about performance.** Latency is recorded and never gates.
- **That the data is right.** Parity means the two engines answer the same way; if
  legacy has a bug, a faithful module reproduces it and parity passes.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | every compared endpoint agreed — read the coverage line before acting |
| 1 | at least one endpoint diverged |
| 2 | misconfigured — bad or missing `--config`, unknown argument, control and candidate URLs identical |
| 3 | **refused to run** — production target, no staging marker, or a "clean" run that compared nothing |

Code 3 also covers a clean run in which no comparable endpoint was exercised. That
combination — nothing compared, nothing disagreed — is reported as a refusal rather
than a pass, because it is indistinguishable from success in every other respect.

3 is deliberately distinct from 1: "the harness declined to point at this database"
is not a parity failure, and confusing them sends someone hunting for a divergence
that was never tested.
