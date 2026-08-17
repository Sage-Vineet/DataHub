## Why

The `Centuriuum Product Listing` (93 features across 15 modules) is the first document that describes
the **whole product**, not a slice of it. Until now the OpenSpec repo has held re-architecture changes
— auth, companies, folders, uploads, requests, messages, reports — each specified against the legacy
behavior it replaces. That is the right frame for a rewrite and the wrong frame for a roadmap: it can
say what today's code does, and nothing about the ~80% of the product surface that does not exist yet.

Without a surface map, three things go wrong, and two of them already have:

- **Cross-cutting capabilities get rediscovered inside features.** The product list itself shows this:
  e-signature is described inside NDA (`BR - 0002`), then re-described inside engagement letters,
  IOI/LOI, and buyer attestations before being pulled out as `SY - 0004`. The activity log
  (`SE - 0004`) is a prerequisite for document watermarking and the entire buyer-engagement analytics
  feature, and is explicitly flagged "build early rather than retrofitted".
- **Re-architecture sequencing gets made blind.** The cutover order in
  `docs/MODERNIZATION_PLAN.md` §5 was drawn from the legacy code's shape. Some of what it treats as an
  endpoint — `reports`, `quickbooks` — is the *foundation* of eight later modules.
- **Feature IDs drift.** The list already references 15 identifiers that do not exist in it (`BO-0001`
  through `BO-0006`, `LO-0001` through `LO-0003`, `IN-0005`, `VL-0007` through `VL-0010`, `RP-0004`,
  `QA-0003`) — evidence of at least one renumbering that the cross-references did not follow. Every
  week that passes makes that harder to reconcile.

This change establishes the **whole-surface capability map**: every one of the 93 features placed in a
capability, expressed as testable requirements rather than paragraphs of intent, with the dependency
edges between them made explicit.

**Cutover-order domain:** none — this is a **specification-only change**. It adds no code and touches
no runtime. It is the map the domain changes are sequenced against.

## What Changes

- **20 new capability specs** covering all 93 features. The delta specs are deliberately at *sketch*
  fidelity: each feature becomes a requirement with the scenarios that make it falsifiable, not an
  implementation-ready spec. Depth comes per-feature, in its own change, when it is scheduled — the
  companion `data-retrieve-wizard` change is the worked example of that fidelity step.
- **Module → capability mapping**, where the product list's modules are reorganized for cohesion:
  the 16-feature Broker module splits into `broker-workspace` / `deal-marketing` / `deal-execution`;
  the Security module's audit log and the System module's e-signature service become their own
  capabilities because both are consumed platform-wide.
- **Dependency graph and build-order recommendation** (`design.md`), including the four capabilities
  that gate large parts of the surface.
- **Reconciliation register** for the 15 dangling feature IDs and the substantive contradictions
  between the product list and the existing re-architecture plan.

## Capabilities

### New Capabilities

| Capability | Product-list features |
|---|---|
| `user-profiles` | US-0001 … US-0005 |
| `access-control` | SE-0001, SE-0002, SE-0003 |
| `activity-log` | SE-0004 |
| `platform-services` | SY-0001, SY-0002, SY-0003 |
| `e-signature` | SY-0004 |
| `data-room` | DR-0001 … DR-0006 |
| `external-integrations` | DR-0007, DR-0008 |
| `financial-data` | DB-0001 … DB-0010 |
| `reports` | RP-0001 … RP-0003 |
| `qoe` | QE-0001 … QE-0015 |
| `projection-model` | PJ-0001 … PJ-0005 |
| `valuations` | VL-0001 … VL-0006 |
| `deal-qa` | QA-0001, QA-0002 |
| `cim` | CM-0001 … CM-0005 |
| `broker-workspace` | BR-0001 … BR-0006 |
| `deal-marketing` | BR-0007 … BR-0011 |
| `deal-execution` | BR-0012 … BR-0016 |
| `buyer-workspace` | BY-0001 … BY-0007 |
| `bank-portal` | BK-0001 |
| `company-portal` | CP-0001, CP-0002 |

`DR - 0003` (Data Retrieve Wizard) is referenced by `data-room` but specified in full by the separate
`data-retrieve-wizard` change, which is at implementation fidelity.

## Impact

- **Code:** none. No package, module, schema, or route is added or changed by this change.
- **Data:** none.
- **Runtime behavior:** none.
- **Existing specs:** `auth`, `design-system`, and `platform/api-gateway` are unaffected and remain
  authoritative for their areas. The `reports` capability here describes the *product* reports surface
  (`RP - 0001..0003`); the in-flight `reports-domain` change describes the key-report **version
  lifecycle**. They converge on one capability and the overlap is called out in `design.md`.
- **Sequencing:** `design.md` recommends re-ordering parts of `docs/MODERNIZATION_PLAN.md` §5 in light
  of the product dependencies. That recommendation is a proposal for the CTO to accept or reject — this
  change does not amend the plan.
- **Branch:** `ba/product-surface-specs` off `ba/rearch`; `main` remains frozen. No legacy impact.

## Non-goals

- **Implementation-ready detail.** These are sketches sized to be argued with, not built from. A
  feature gets its own change at `data-retrieve-wizard` fidelity when it is scheduled — attempting 93
  of those now would produce 93 documents that are stale before anyone reads them.
- **Estimation.** The source list carries `TBD` in every Dev Effort cell; nothing here invents one.
- **Deciding the open product questions.** They are registered in `design.md` with what each one blocks,
  and left open.
- **Amending the modernization plan or the cutover order.** A recommendation is made; the decision is
  not taken here.
- **Any commitment to the external data providers** named in `DR - 0008` / `VL - 0003` / `VL - 0004`.
  That is a recurring-cost decision, flagged as one, not made here.
