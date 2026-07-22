// Per-account classification layers 2–7, 9, and 11 of the priority order.
// Layer 1 (existing hierarchy) and Layer 8 (section totals as boundaries)
// live in treeWalk.js because they are structural, not per-account. Layer 10
// (historical cache) lives in historyCache.js and Layer 12 (AI) in
// aiClassifier.js because both need external state/IO.
//
// Every function here is pure and independently testable: given an `item`
// context ({ node, section, subsectionHint, categoryHint, meta }), it either
// returns a resolution ({ label, subsection }) or null. `label` may be null
// when a layer can only narrow the subsection, not the specific category —
// the engine keeps trying subsequent layers (constrained to that
// subsection) until a specific category is found or every layer is spent.

import { CATEGORIES_BY_SECTION, ACCOUNT_TYPE_TO_SECTION, CONTRA_PATTERNS, DEFAULT_ACCOUNT_NUMBER_RANGES, SECTION } from "./canonical.js";

function normalizeToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenMatches(normToken, keyword) {
  if (!normToken || !keyword) return false;
  return normToken.includes(keyword) || keyword.includes(normToken);
}

/**
 * Layer 2 — Chart of Accounts metadata. When the source already supplies an
 * authoritative classification (e.g. its own COA "section"/"category"
 * fields), trust it outright. This is a metadata lookup, not text matching.
 */
export function classifyByCoaMetadata(item) {
  const meta = item.meta || {};
  const section = meta.coaSection;
  if (!section || !CATEGORIES_BY_SECTION[section]) return null;
  const categories = CATEGORIES_BY_SECTION[section];
  const match = meta.coaCategory ? categories.find((c) => c.label === meta.coaCategory) : null;
  if (match) return { label: match.label, subsection: match.subsection };
  if (meta.coaSubsection) return { label: null, subsection: meta.coaSubsection };
  return null;
}

/**
 * Layer 3 — Account Type. A coarse ERP-native type string (QuickBooks
 * `AccountType`, Xero `Type`, Sage/NetSuite/Dynamics equivalents) mapped to
 * (section, subsection). Checked against the STRUCTURED type field, never
 * the free-text account name.
 */
export function classifyByAccountType(item) {
  const raw = item.meta?.accountType;
  if (!raw) return null;
  const norm = normalizeToken(raw);
  if (!norm) return null;
  const entry = ACCOUNT_TYPE_TO_SECTION.find((e) => e.keywords.some((k) => tokenMatches(norm, k)));
  if (!entry || entry.section !== item.section) return null;
  return { label: null, subsection: entry.subsection };
}

/**
 * Layer 4 — Account Subtype. A finer-grained ERP-native subtype string
 * (QuickBooks `AccountSubType`, etc.) mapped directly to a canonical
 * category. Checked against the STRUCTURED subtype field, never the name.
 */
export function classifyByAccountSubType(item) {
  const raw = item.meta?.accountSubType;
  if (!raw) return null;
  const norm = normalizeToken(raw);
  if (!norm) return null;
  const categories = CATEGORIES_BY_SECTION[item.section] || [];
  for (const cat of categories) {
    if (item.subsectionHint && cat.subsection !== item.subsectionHint) continue;
    if (cat.subtypeKeywords.some((k) => tokenMatches(norm, k))) {
      return { label: cat.label, subsection: cat.subsection };
    }
  }
  return null;
}

/**
 * Layer 5 — Parent Account. If this account's COA parent has already been
 * resolved (earlier in this same run, keyed by account id), inherit its
 * classification directly instead of re-deriving one.
 */
export function classifyByParentAccount(item, resolvedByAccountId) {
  const parentId = item.meta?.parentAccountId;
  if (!parentId || !resolvedByAccountId) return null;
  const parentResult = resolvedByAccountId.get(String(parentId));
  return parentResult ? { label: parentResult.label, subsection: parentResult.subsection } : null;
}

/**
 * Layer 6 — Account Number. A structured account number, or a numeric
 * prefix embedded in the display name (e.g. "1000 Cash"), checked against
 * configurable Chart-of-Accounts numbering ranges. This is number
 * EXTRACTION and range lookup — a structural/format operation, not semantic
 * name matching.
 */
export function extractAccountNumber(name) {
  const m = String(name || "").match(/^\s*(\d{3,6})\b/);
  return m ? Number(m[1]) : null;
}

export function classifyByAccountNumber(item, ranges = DEFAULT_ACCOUNT_NUMBER_RANGES) {
  const raw = item.meta?.accountNumber != null ? Number(item.meta.accountNumber) : extractAccountNumber(item.node?.name);
  if (raw == null || Number.isNaN(raw)) return null;
  const range = (ranges || []).find((r) => raw >= r.min && raw <= r.max);
  if (!range || range.section !== item.section) return null;
  return { label: null, subsection: range.subsection };
}

/**
 * Layer 7 — Normal Balance. Debit/credit metadata is too coarse to pick a
 * specific category on its own, but combined with the section we already
 * know (from Layer 1's root detection) it is a genuine signal for
 * contra-account detection: a credit-normal account sitting in Assets (or a
 * debit-normal one in Liabilities/Equity) is a strong contra indicator.
 */
export function normalBalanceContraSuspect(item) {
  const normalBalance = String(item.meta?.normalBalance || "").toLowerCase();
  if (normalBalance !== "debit" && normalBalance !== "credit") return false;
  const expected = item.section === SECTION.ASSETS ? "debit" : "credit";
  return normalBalance !== expected;
}

/**
 * Layer 9 — Neighboring accounts. For items still unresolved after layers
 * 1–8, adopt the unanimous classification of already-resolved siblings in
 * the same scope. `resolvedSiblings` must exclude the item itself.
 */
export function classifyByNeighbors(resolvedSiblings) {
  if (!resolvedSiblings || !resolvedSiblings.length) return null;
  const distinct = new Set(resolvedSiblings.map((r) => `${r.subsection || ""}::${r.label || ""}`));
  if (distinct.size !== 1) return null;
  const [only] = resolvedSiblings;
  return { label: only.label, subsection: only.subsection };
}

/**
 * Layer 11 — Lexicon. The last deterministic resort: a comprehensive,
 * multi-region (US GAAP / IFRS / UK / India / Canada / Australia) synonym
 * dictionary matched against the free-text account name.
 */
export function classifyByLexicon(item) {
  const name = item.node?.name || "";
  const categories = CATEGORIES_BY_SECTION[item.section] || [];
  for (const cat of categories) {
    if (item.subsectionHint && cat.subsection !== item.subsectionHint) continue;
    if (cat.lexicon.some((re) => re.test(name))) {
      return { label: cat.label, subsection: cat.subsection };
    }
  }
  return null;
}

/**
 * Contra-account detection — cross-cutting, applied after a category is
 * resolved. Never changes WHICH category an account belongs to, only its
 * order within it (contra accounts sort after the gross accounts they
 * offset, immediately before that category's own Total row).
 */
export function detectContra(item) {
  const name = item.node?.name || "";
  if (CONTRA_PATTERNS.some((re) => re.test(name))) return true;
  return normalBalanceContraSuspect(item);
}

// Ordered so the engine can iterate metadata-based layers generically; each
// entry names the layer for audit/debugging (`_classifiedBy` on the result).
export const METADATA_LAYERS = [
  { name: "coa-metadata", run: classifyByCoaMetadata },
  { name: "account-type", run: classifyByAccountType },
  { name: "account-subtype", run: classifyByAccountSubType },
];
