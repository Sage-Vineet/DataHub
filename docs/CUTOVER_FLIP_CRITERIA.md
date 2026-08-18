# Cutover flip criteria

> Status: current as of the `staging-parity-harness` change
> Tool: `pnpm --filter @datahub/api parity` · Spec: `openspec/changes/staging-parity-harness/`

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
- [ ] **Coverage read, not just the verdict.** The report states `compared N of M`.
      If N < M, the run sampled the surface; the skipped list says why each one was
      missed and each reason has a different fix:
      - `mutation-not-permitted` → re-run with `PARITY_ALLOW_MUTATION=true`
      - `no-fixture` → add a fixture with real ids from the snapshot
      - `auth-required` → configure `PARITY_SESSION_TOKEN` for a seeded user
      - `request-failed` → the environment, not the code — fix and re-run
      - `additive-endpoint` → module-only by design; nothing to compare
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
- [ ] The machine-readable report (`PARITY_JSON_OUT`) is attached to the cutover
      change, so the evidence the decision rested on is recoverable later.
- [ ] The deletion is a **separate, revertable commit**.

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
| 2 | misconfigured (missing `DATABASE_URL` or origins) |
| 3 | **refused to run** — production target, or no staging marker |

3 is deliberately distinct from 1: "the harness declined to point at this database"
is not a parity failure, and confusing them sends someone hunting for a divergence
that was never tested.
