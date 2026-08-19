# Jira workspace — CEN (Centuriuum)

<https://hubonesystems.atlassian.net/jira/software/projects/CEN/boards/156/backlog>

Team-managed software project. Set up 18 Aug 2026, seeded from this repository:
164 issues covering everything delivered on `ba/rearch` plus the whole 98-feature
product surface.

## Hierarchy

```
Epic  ─┬─ Story / Task / Bug     delivery work (what we built, what is open)
       └─ Feature                product surface (what the product should be)
```

`Feature` and `Story` are both hierarchy level 0 in this project — `Feature` is used
purely to distinguish product-surface items from delivery work at a glance.

## Epics

**Delivery (CEN-1 … CEN-6, CEN-46)** — one per program phase, mirroring the work log:

| Epic | Phase | Window |
|---|---|---|
| CEN-1 | Phase 0 — Modernization harness | 7–10 Aug |
| CEN-2 | Phase 1 — Auth reference domain | 10–11 Aug |
| CEN-3 | Phase 2 — Core domains | 11–13 Aug |
| CEN-4 | Cutover platform & staging | 17 Aug |
| CEN-5 | Parity, activity log & product surface | 17 Aug |
| CEN-6 | Spec system remediation | 18 Aug |
| CEN-46 | Open engineering changes | current |

**Product surface (CEN-53 … CEN-66)** — one per product module: `SY`, `DB`, `DR`,
`QE`, `BR`, `VL`, `CM`, `BY`, `CP`, `PJ`, `QA`, `RP`, `US`, `BK`.

**CEN-165 — QoE program, Sept 1 1.0.** Added 19 Aug from the 12–18 Aug check-ins.
17 stories and the 8 open UAT defects as bugs, sequenced foundation-first. The
`qoe-program` label selects the whole programme; `sept1` marks anything in the
1.0 scope; `foundation` marks the six items that close six of the eight UAT
defects and unblock four of the five modules.

```jql
project = CEN AND labels = "qoe-program" ORDER BY key
project = CEN AND labels = "foundation" AND statusCategory != Done
```

## The backdating constraint

Jira stamps `created` on insert and it **cannot** be set through the REST API — it is
absent from the project's create metadata, along with `resolutiondate`. Every issue
therefore shows a Created date of 18 Aug 2026 regardless of when the work happened.

The real timeline lives in fields that *are* writable:

- **Start date** (`customfield_10701`) and **Due date** — set from the actual commit
  dates, so timeline and roadmap views read correctly.
- **Description** — every historical issue names its real delivery date and commit SHA.

Do not treat the Created column as history. Query by `"Start date"` instead.

## Labels

Labels carry the structure, since a team-managed project has no components.

| Label | Meaning |
|---|---|
| `delivery` | Delivery work rather than product surface |
| `backdated` | Historical: real dates are in Start/Due and the description |
| `product-surface` | A feature from the Centuriuum product list |
| `module-<xx>` | Product module: `module-qe`, `module-br`, … |
| `fidelity-specified` | Derived from a feature specification document (59 features) |
| `fidelity-product-list` | Substantive product-list summary, no document |
| `fidelity-sketch` | One-to-three sentence row only |
| `fidelity-undecided` | `DB - 0010` — conceptual, deliberately unresolved |
| `needs-spec-doc` | No specification document exists (38 features + 4 module epics) |
| `gate` | Gating capability — blocks other work |
| `<id>` | The feature ID itself, e.g. `qe-0004`, `sy-0007` |
| `openspec` | Has a corresponding OpenSpec artifact |
| `security` | Security fix or security-relevant |
| `decision` | Awaiting a decision, not developer capacity |
| `unscheduled` | Ready to build, no position in the plan |
| `blocked-by-esignature` | Waiting on `SY - 0007` |
| `blocked-by-sketch` | Specified feature resting on unspecified dependencies |
| `queue-now` | Next up — unblocked and worth starting now |
| `queue-next` | Follows the `queue-now` set |

Useful queries:

```jql
project = CEN AND labels = "needs-spec-doc" AND issuetype = Feature
project = CEN AND labels = "gate" ORDER BY status
project = CEN AND labels = "decision"
project = CEN AND labels = "delivery" AND "Start date" >= 2026-08-17
project = CEN AND labels = "fidelity-specified" AND issuetype = Feature
project = CEN AND labels in ("queue-now", "queue-next") ORDER BY labels
```

## Board membership vs status

The board at `/boards/156` keeps a **Backlog** list separate from the board columns,
and membership of that list is independent of status. Issues created through the REST
API land in the Backlog regardless of their status — so the 45 issues that are
genuinely `Done` still sit in the Backlog until moved.

There is no Agile/board endpoint in the Atlassian MCP tooling, so this cannot be
scripted from here — and neither can **sprint assignment**. This is a team-managed
project with no `sprint` field exposed on the issue, so putting the `queue-now` set
into a sprint is a UI action. Status, labels, story points, start dates, parents and
links are all scriptable and are kept correct from here. To fix it in the UI: open the Backlog, select the issues (click
the first, shift-click the last), right-click → **Move to board**. Done issues drop
straight into the Done column because their status is already correct.

`statusCategory` is the reliable signal in JQL either way:

```jql
project = CEN AND statusCategory = Done        -- 45
project = CEN AND statusCategory != Done       -- 119
```

## Fidelity reconciliation

98 features total, matching `openspec/product/design.md` §D3 exactly:

| Fidelity | Features |
|---|---:|
| specified — has a specification document | 59 |
| product-list detail / sketch — `needs-spec-doc` | 38 |
| undecided — `DB - 0010` | 1 |

## Dependency links

32 links, drawn from `openspec/product/design.md` §D4 (gates) and §D7 (computed graph).

**Gates, and what they block:**

- `SY - 0007` e-signature (CEN-111) → `BR - 0002`, `BR - 0008`, `BR - 0012`,
  `BR - 0013`, `BY - 0007`. **Specified, implementation-ready, unscheduled.**
- `SY - 0003` activity log (CEN-107) → `DR - 0006`, `BR - 0010`, `BR - 0011`,
  `VL - 0010`. Capture side **built** — it could not be retrofitted.
- `SY - 0001` / `SY - 0002` access control (CEN-105/106) → every module.
- `VL - 0006` purpose & standard of value (CEN-129) → the valuations module.
- `DR - 0003` Data Retrieve Wizard (CEN-98) → `DB - 0002`, and through it the 39
  features downstream of `financial-data`.

`Relates` links connect each product capability to the shipped baseline that partly
serves it — `DR - 0001` ↔ folders/uploads, `SY - 0001` ↔ users, `SY - 0002` ↔
companies, `DB - 0001` ↔ reports-domain (the open §D6 reconciliation).

## Keeping it in sync

The repository is the source of truth; Jira is the view. When a change is archived
in `openspec/changes/archive/`, close its Story. When a specification document
arrives for a sketch feature, swap `fidelity-sketch` → `fidelity-specified`, drop
`needs-spec-doc`, and open an OpenSpec change at `data-retrieve-wizard` fidelity
before scheduling it.

Nothing automated enforces this yet. `tools/openspec/validate.mjs` keeps the specs
honest; it does not know about Jira.
