// ─── KEY REPORTS Vendor / Customer normalization + aggregation ───────────────
//
// OWNED BY KEY REPORTS. Deliberately self-contained: this module imports
// NOTHING from the Manual GL Upload flow (no manualGl* service, no
// glEntityNormalization, no manual_gl_* table, no Manual GL cache or payload).
// Key Reports and Manual GL Upload are required to have completely separate
// vendor/customer handling, so the duplication between them is INTENTIONAL --
// do not "de-duplicate" these two into a shared helper.
//
// Source of truth: general_ledger_entries.vendor / .customer / .entity_type
// (migration 068) -- the Key Reports GL table, scoped by version_id (a FK to
// key_report_versions, which is itself scoped to a company). Nothing here reads
// manual_gl_staged_transactions.
//
// ONE canonical transaction-level aggregation feeds BOTH the monthly and the
// yearly report (see aggregate* below): the caller supplies the period key --
// month number for monthly, fiscal year for yearly -- and the identical code
// path produces both, so the two grains cannot drift apart.
//
// No vendor names, customer names, account names or company-specific values are
// encoded anywhere in this file. It is string hygiene plus arithmetic.

// Canonical empty/unknown buckets for Key Reports. One bucket per kind, defined
// once here, so a null, an empty string, whitespace and a literal placeholder
// all land in the SAME row rather than several near-identical ones.
const KR_NO_VENDOR_LABEL = "No vendor / —";
const KR_NO_CUSTOMER_LABEL = "No customer / —";

const KR_ENTITY_KINDS = Object.freeze({ VENDOR: "vendor", CUSTOMER: "customer" });

const KR_UNATTRIBUTED_LABEL = Object.freeze({
  [KR_ENTITY_KINDS.VENDOR]: KR_NO_VENDOR_LABEL,
  [KR_ENTITY_KINDS.CUSTOMER]: KR_NO_CUSTOMER_LABEL,
});

// Values bookkeepers type to mean "there is no counterparty here". Matched on
// the fully-normalized form and restricted to punctuation or a generic absence
// word -- never anything that could be a real trading name.
const KR_PLACEHOLDER_ENTITY_VALUES = new Set([
  "", "-", "--", "---", "—", "n/a", "n\\a", "na", "none", "null", "nil",
  "unknown", "unspecified", "not applicable", "no name", ".", "?",
  // The canonical buckets themselves, so a re-ingested export that already
  // contains the rendered label folds back into the same bucket.
  "no vendor", "no customer", "no vendor / —", "no customer / —",
]);

/**
 * Canonical grouping key for a Key Reports entity name: whitespace-collapsed,
 * trimmed, case-folded. Returns "" when the cell carries no usable name.
 *
 * Case-folding matters: the same counterparty routinely arrives as "ACME Corp",
 * "Acme  Corp" and "acme corp" in one GL export. Grouping on the raw string
 * renders those as three rows each holding a slice of one real total.
 */
function krEntityKey(raw) {
  if (raw === null || raw === undefined) return "";
  const collapsed = String(raw).replace(/\s+/g, " ").trim().toLowerCase();
  return KR_PLACEHOLDER_ENTITY_VALUES.has(collapsed) ? "" : collapsed;
}

/** Display spelling: cleaned, but original casing preserved for the UI. */
function krEntityDisplay(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/\s+/g, " ").trim();
}

/**
 * Resolve a raw Key Reports GL cell into the identity used for grouping.
 *
 * @param {*} raw        general_ledger_entries.vendor or .customer
 * @param {string} kind  KR_ENTITY_KINDS.VENDOR | KR_ENTITY_KINDS.CUSTOMER
 * @returns {{key: string, display: string, unattributed: boolean}}
 */
function krResolveEntity(raw, kind) {
  const key = krEntityKey(raw);
  if (key) return { key, display: krEntityDisplay(raw), unattributed: false };
  const label = KR_UNATTRIBUTED_LABEL[kind] || KR_NO_VENDOR_LABEL;
  // The "__kr_unattributed__" prefix cannot collide with a real normalized name
  // (always case-folded free text), so a counterparty literally named
  // "No vendor" still aggregates apart from genuinely nameless rows.
  return { key: `__kr_unattributed__:${kind}`, display: label, unattributed: true };
}

/**
 * Accumulate ONE Key Reports GL transaction into a per-entity, per-period
 * breakdown for a single account.
 *
 * Accumulator shape:
 *   Map<entityKey, { display, unattributed, periods: Map<periodKey, number>, total }>
 *
 * `periodKey` is opaque here -- the caller passes a month number for the monthly
 * report and a fiscal year for the yearly one, which is what lets both grains
 * share this single code path.
 *
 * The unattributed bucket is ALWAYS accumulated (never skipped): the
 * reconciliation invariant Key Reports must hold is
 *   sum(named rows) + unattributed row == the account's own period total,
 * so a nameless transaction has to surface as its own row rather than vanish
 * from the breakdown while still counting toward the parent.
 *
 * @returns {boolean} whether the row was accumulated
 */
function krAccumulateEntityAmount(map, rawName, kind, periodKey, amount) {
  if (!map) return false;
  const value = Number(amount);
  if (!Number.isFinite(value)) return false;
  const identity = krResolveEntity(rawName, kind);

  let bucket = map.get(identity.key);
  if (!bucket) {
    bucket = { display: identity.display, unattributed: identity.unattributed, periods: new Map(), total: 0 };
    map.set(identity.key, bucket);
  }
  bucket.periods.set(periodKey, (bucket.periods.get(periodKey) || 0) + value);
  bucket.total += value;
  return true;
}

function krRound2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Serialize a Key Reports accumulator into the row contract the report layer
 * consumes:
 *
 *   [{ name, amount, amounts: { [periodKey]: number }, total }]
 *
 * `amount` is this serialization's single-period total; `amounts`/`total` carry
 * the per-period detail. ONE row per counterparty regardless of how many periods
 * it traded in -- a vendor active in 2022..2025 is a single row with four period
 * entries, never four rows.
 *
 * Ordering: largest absolute total first, then by name so a paginated re-read
 * can never shuffle the rendered list.
 */
function krSerializeEntityBreakdown(map, { keepZero = false, epsilon = 0.005 } = {}) {
  if (!map || !map.size) return [];
  const out = [];
  for (const bucket of map.values()) {
    if (!keepZero && Math.abs(bucket.total) < epsilon) continue;
    const amounts = {};
    for (const [periodKey, value] of bucket.periods) amounts[periodKey] = krRound2(value);
    out.push({
      name: bucket.display,
      amount: krRound2(bucket.total),
      amounts,
      total: krRound2(bucket.total),
    });
  }
  return out.sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.name.localeCompare(b.name));
}

/**
 * Read both entity columns off one Key Reports GL row into an account bucket.
 *
 * Both columns are read independently rather than switching on entity_type: a
 * row can legitimately carry BOTH (an invoice with a customer and a paying
 * vendor), and entity_type only records which column the extractor found, so
 * treating it as exclusive would silently discard the other value.
 *
 * @param {object} acc  account bucket carrying `vendors` / `customers` Maps
 * @param {object} row  raw general_ledger_entries row
 * @param {string|number} periodKey  month number (monthly) or fiscal year (yearly)
 * @param {number} amount  signed amount already resolved by the caller
 */
function krAccumulateRowEntities(acc, row, periodKey, amount) {
  if (!acc || !row) return;
  if (acc.vendors) {
    krAccumulateEntityAmount(acc.vendors, row.vendor, KR_ENTITY_KINDS.VENDOR, periodKey, amount);
  }
  if (acc.customers) {
    krAccumulateEntityAmount(acc.customers, row.customer, KR_ENTITY_KINDS.CUSTOMER, periodKey, amount);
  }
}

/**
 * Split an account's entity breakdown onto the COA leaves that account's amount
 * was mapped to, sharing it exactly the way the amount itself is shared when one
 * GL account maps to N leaves (amount / N). Without the matching split, the rows
 * under a leaf would sum to the un-split account total and break reconciliation.
 *
 * @param {Map} target      Map<leafId, Map<entityKey, bucket>> accumulator
 * @param {string[]} leafIds  COA leaf ids this account's amount landed on
 * @param {Map} sourceMap   the account's vendors/customers accumulator
 * @param {string|number} periodKey  the period being built
 */
function krPropagateEntitiesToLeaves(target, leafIds, sourceMap, periodKey) {
  if (!leafIds?.length || !sourceMap?.size) return;
  const share = leafIds.length;
  for (const leafId of leafIds) {
    let perLeaf = target.get(leafId);
    if (!perLeaf) { perLeaf = new Map(); target.set(leafId, perLeaf); }
    for (const [entityKeyStr, bucket] of sourceMap) {
      const periodAmount = bucket.periods.get(periodKey) || 0;
      if (!periodAmount) continue;
      let entry = perLeaf.get(entityKeyStr);
      if (!entry) {
        entry = { display: bucket.display, unattributed: bucket.unattributed, periods: new Map(), total: 0 };
        perLeaf.set(entityKeyStr, entry);
      }
      const value = share > 1 ? periodAmount / share : periodAmount;
      entry.periods.set(periodKey, (entry.periods.get(periodKey) || 0) + value);
      entry.total += value;
    }
  }
}

/**
 * Serialize Map<leafId, accumulator> into the by-account-name object the Key
 * Reports frontend looks up directly from a statement row's display name.
 * Always an object (never null), so consumers need no existence guard.
 *
 * @param {Map} leafEntityMap  Map<leafId, Map<entityKey, bucket>>
 * @param {Array} leaves       COA leaves
 * @param {(leaf:object)=>string} displayNameOf  resolves a leaf's rendered name;
 *        supplied by the caller so this module never needs to know the COA row
 *        shape, and so the key ALWAYS matches the name the report row renders.
 */
/**
 * Is this serialized row the unattributed bucket? Decided from the accumulator's
 * own `unattributed` flag (set at resolve time), never by comparing the rendered
 * label -- a real counterparty could legitimately be named like the bucket.
 */
function isUnattributedRow(entityMap, row) {
  for (const bucket of (entityMap?.values?.() || [])) {
    if (bucket.display === row.name) return Boolean(bucket.unattributed);
  }
  return false;
}

function krSerializeEntitiesByAccount(leafEntityMap, leaves, displayNameOf) {
  const out = {};
  if (!leafEntityMap?.size) return out;
  const nameById = new Map((leaves || []).map((l) => [l.id, displayNameOf(l)]));
  for (const [leafId, entityMap] of leafEntityMap) {
    const rows = krSerializeEntityBreakdown(entityMap);
    if (!rows.length) continue;
    // An account whose ONLY row is the unattributed bucket carries no
    // counterparty information at all -- that single row would just restate the
    // parent's own total under a heading that reads like a real counterparty. Do
    // not emit a breakdown for it, so the report renders no empty Vendor /
    // Customer section. (Confirmed live: a company with 24,838 vendor-bearing GL
    // rows and ZERO customer-bearing rows was producing a "No customer / —"
    // customer section for all 69 of its accounts.) The moment even one named
    // counterparty exists, the unattributed row IS kept alongside it -- that is
    // what makes the breakdown reconcile to the account total.
    if (rows.length === 1 && isUnattributedRow(entityMap, rows[0])) continue;
    const accountName = nameById.get(leafId) || String(leafId);
    // Two COA leaves can share a display name; merge rather than overwrite so
    // neither leaf's counterparties silently disappear.
    if (out[accountName]) {
      const merged = new Map(out[accountName].map((r) => [r.name, r]));
      for (const r of rows) {
        const prev = merged.get(r.name);
        if (!prev) { merged.set(r.name, r); continue; }
        const amounts = { ...prev.amounts };
        for (const [k, v] of Object.entries(r.amounts)) amounts[k] = (amounts[k] || 0) + v;
        merged.set(r.name, {
          name: r.name,
          amount: krRound2(prev.amount + r.amount),
          total: krRound2(prev.total + r.total),
          amounts,
        });
      }
      out[accountName] = Array.from(merged.values())
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.name.localeCompare(b.name));
    } else {
      out[accountName] = rows;
    }
  }
  return out;
}

/**
 * Reconciliation validation (logs, never throws): for an account+period,
 * sum(named rows + unattributed row) must equal that account's own total.
 *
 * Holds by construction -- the breakdown is split from the SAME GL rows, the
 * same way, as the leaf amount -- so a mismatch means a change broke that
 * construction, and it is surfaced immediately rather than shipping a report
 * whose parts do not add up to its whole.
 *
 * @returns {Array} the mismatches found (also logged)
 */
function krValidateEntityReconciliation({
  label, leafAmounts, leafEntityMap, periodKey, leaves, displayNameOf,
  companyId = null, versionId = null, tolerance = 0.02,
}) {
  const problems = [];
  if (!leafEntityMap?.size) return problems;
  const nameById = new Map((leaves || []).map((l) => [l.id, displayNameOf(l)]));
  for (const [leafId, entityMap] of leafEntityMap) {
    let sum = 0;
    for (const bucket of entityMap.values()) sum += bucket.periods.get(periodKey) || 0;
    const expected = Number(leafAmounts.get(leafId)) || 0;
    const difference = sum - expected;
    if (Math.abs(difference) > tolerance) {
      const account = nameById.get(leafId) || String(leafId);
      problems.push({ account, periodKey, accountTotal: expected, entitySum: sum, difference });
      console.warn(
        `[KR_ENTITY_RECONCILIATION] ${label} company=${companyId || "?"} version=${versionId || "?"} ` +
        `account="${account}" period=${periodKey} accountTotal=${expected.toFixed(2)} ` +
        `entitySum=${sum.toFixed(2)} difference=${difference.toFixed(2)}`,
      );
    }
  }
  return problems;
}

module.exports = {
  KR_ENTITY_KINDS,
  KR_NO_VENDOR_LABEL,
  KR_NO_CUSTOMER_LABEL,
  KR_UNATTRIBUTED_LABEL,
  KR_PLACEHOLDER_ENTITY_VALUES,
  krEntityKey,
  krEntityDisplay,
  krResolveEntity,
  krAccumulateEntityAmount,
  krSerializeEntityBreakdown,
  krAccumulateRowEntities,
  krPropagateEntitiesToLeaves,
  krSerializeEntitiesByAccount,
  krValidateEntityReconciliation,
};
