# `@datahub/parity` — cutover parity harness

Replays the same request against **legacy** and **the new TypeScript module** and
reports where they behave differently.

Every domain change carries a task worded roughly "enable in staging; parity
checklist against the real DB". This turns that sentence into something
repeatable that produces evidence and an exit code, so a flag flip is a decision
backed by a run rather than by someone clicking around.

## The idea

```
                 ┌──────────────────────── control  (flag OFF → legacy serves it)
same request ────┤
                 └──────────────────────── candidate (flag ON  → module serves it)
                            │
                    normalise → diff → report → exit 0/1
```

Both upstreams are the **same gateway image**, differing only in the domain's
`*_MODULE_ENABLED` flag. That is exactly the difference a cutover introduces, so
it is the only difference the run should surface.

## Running it

```bash
cp tools/parity/parity.config.example.json tools/parity/parity.config.json
$EDITOR tools/parity/parity.config.json     # URLs, credentials, fixture ids

pnpm --filter @datahub/parity parity -- --config tools/parity/parity.config.json --domain folders
```

Exit codes are the contract: `0` clean, `1` differences or errors, `2` the run
could not be performed. `--json` emits a machine-readable report to keep as the
soak record.

Two gateways are needed — one with the flag off, one on. With the staging compose:

```bash
# control on :8080 (all flags off)
JWT_SECRET=... docker compose -f docker-compose.staging.yml up -d gateway

# candidate on :8081 (one flag on)
JWT_SECRET=... GATEWAY_PORT=8081 FOLDERS_MODULE_ENABLED=true \
  docker compose -f docker-compose.staging.yml -p datahub-candidate up -d gateway
```

## Why the noise controls matter

Two implementations never return identical bytes: ids are generated, timestamps
differ, and SQL without `ORDER BY` returns rows in plan order. A harness that
reports all of that gets ignored — which is worse than not having one. So each
scenario declares what is *allowed* to differ, and everything else is signal:

- `volatile` masks a **value** but still compares the **key**, so a field that
  vanishes entirely is still caught.
- `sortArraysBy` is opt-in per path. Where order is part of the contract, leave
  it out and a reordering is reported.
- `ignore` drops a path entirely. Use sparingly — it is how a real difference
  gets hidden.

Declarations are deliberately narrow (`created_at`, not `*`) so widening one is a
visible, reviewable act.

Differences are classified so they can be triaged before a flip:

| kind | severity | why |
|---|---|---|
| `status` | critical | client-visible behaviour change |
| `type` | critical | `"3"` vs `3` breaks arithmetic downstream |
| `missing-field` | major | the SPA may read it |
| `value` | major | same shape, different answer |
| `extra-field` | minor | additive, but unspecified surface |

## Scenarios

Each scenario names the delta-spec requirement it exercises, so the suite stays
traceable to `openspec/changes/<change>/specs/` instead of being an unmoored pile
of curl commands.

Coverage leans on **reads, tenant boundaries and error paths**: they need no
seeded mutation, are safe to replay against both upstreams, and are where a
rewrite most often diverges. Write flows are marked `mutating` and skipped unless
`--allow-mutating` is passed — replaying them hits **both** upstreams and
therefore writes twice to the shared database. Staging only, never production.

Scenarios depending on optional fixtures (`folderId`, `requestId`, …) are omitted
when those ids are absent, so a thin config still runs rather than erroring.

## What a clean run does and does not mean

It means: *the declared scenarios, against the data currently seeded, showed no
difference.* It is evidence for a flag flip. It is not proof of parity — an
endpoint nobody wrote a scenario for is untested, and normalisation rules are
assumptions. Treat coverage gaps as gaps.

## Development

```bash
pnpm --filter @datahub/parity test        # 53 tests
pnpm --filter @datahub/parity typecheck
pnpm --filter @datahub/parity lint
```

`runner.test.ts` runs the harness end-to-end against two real Express servers,
asserting it **fails** on a difference that matters and **passes** on ids and
ordering that legitimately differ. One of its cases reproduces the first real
defect this harness found: legacy reads `?includeArchived`, the folders module
read `?include_archived`, so the filter silently stopped applying after cutover.
