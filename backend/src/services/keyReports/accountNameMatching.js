// ============================================================================
// Shared account-name matching utilities (Key Reports)
//
// Extracted from financialStatementService.js so the same matching logic
// (exact -> strict-normalized -> account-number -> fuzzy word-similarity,
// with an accounting-modifier hard gate) can be reused by anything that needs
// to match a raw account name against a set of known accounts — originally
// GL/BS entries against a company's own chart_of_accounts leaves, and now also
// coaMappingService matching a newly-classified account against every other
// already-classified account in chart_of_accounts.
// ============================================================================

"use strict";

// A trailing "(deleted)" / "- Deleted" / "[Deleted]" marks a bank/GL account
// the source system flagged inactive — the underlying real-world account is
// unchanged, so it must still match its live counterpart's hierarchy. Applied
// before anything else so the rest of the pipeline never sees the suffix.
const DELETED_SUFFIX_RE = /[\s\-\(\[]*deleted[\s\)\]]*$/i;
function stripDeletedSuffix(s) {
  return String(s || "").replace(DELETED_SUFFIX_RE, "").trim();
}

// A small, fixed set of universal (not company-specific) accounting
// abbreviations, expanded so e.g. "A/R" and "Accounts Receivable" normalize to
// the same key. Matched as whole words only — never a substring — to avoid
// corrupting an unrelated name. This is name-equivalence normalization for
// matching, not a hierarchy/keyword rule: it never assigns a type or section.
const ABBREVIATION_MAP = [
  [/\ba\s*\/\s*r\b/g, "accounts receivable"],
  [/\ba\s*\/\s*p\b/g, "accounts payable"],
  [/\bcogs\b/g, "cost of goods sold"],
  [/\bp\s*&\s*l\b/g, "profit and loss"],
  [/\bcapex\b/g, "capital expenditure"],
  [/\bopex\b/g, "operating expense"],
  // Matched BEFORE the generic "&" -> " and " step below turns "F&F"/"M&E"
  // into "f and f"/"m and e" — these are initialisms, not real word pairs,
  // so they need their own literal expansion rather than falling through to
  // the generic ampersand rule.
  [/\bf\s*&\s*f\b/g, "furniture and fixtures"],
  [/\bm\s*&\s*e\b/g, "machinery and equipment"],
  [/\baccum\.?\s+dep\.?\b/g, "accumulated depreciation"],
  [/\baccum\.?\s+depr\.?\b/g, "accumulated depreciation"],
];
function expandAbbreviations(s) {
  let out = s;
  for (const [re, expansion] of ABBREVIATION_MAP) out = out.replace(re, expansion);
  return out;
}

/**
 * Primary normalization applied to BOTH sides of every name lookup.
 * `expandAlias` gated so a caller (coaAccountMatcher) can tell whether two
 * names only converged BECAUSE of an alias expansion (F&F -> Furniture and
 * Fixtures) versus converging on punctuation/whitespace alone — used to
 * report the correct match-stage diagnostic, not just whether they match.
 */
function normCore(s, expandAlias) {
  let out = stripDeletedSuffix(s).toLowerCase();
  out = out.replace(/'/g, ""); // "Sam's" -> "Sams" (removed, not spaced) so it matches a raw "Sams" spelling of the same name
  // Abbreviations expanded BEFORE the generic "&" -> " and " substitution below —
  // several entries (F&F, M&E, P&L) match a literal "&" and would never fire
  // if the ampersand were already gone by the time expandAbbreviations runs.
  if (expandAlias) out = expandAbbreviations(out);
  out = out.replace(/&/g, " and ");
  return out
    .replace(/[^a-z0-9\s]/g, " ") // dashes/parentheses/other punctuation → space, not deleted — "Non-Current" stays two words, not "noncurrent"
    .replace(/\s+/g, " ")
    .trim();
}
const norm = (s) => normCore(s, true);
// Same normalization, WITHOUT abbreviation expansion — lets a caller detect
// whether a match only succeeded because of the alias stage.
const normNoAlias = (s) => normCore(s, false);

const normStrict = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Conservative singular/plural folding for the FUZZY word-overlap tier only —
// never applied to the exact/strict tiers, so it can only help two already-
// similar names match a little more often, never merge two different exact
// names. "ies" -> "y" (categories -> category), trailing "s" dropped only for
// words long enough that stripping it can't invert the word's meaning (e.g.
// never touches "gas", "sales" stays "sale" only because len > 4).
function singularize(word) {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// ─── Accounting modifier words ─────────────────────────────────────────────────
// Words/phrases that change an account's accounting meaning rather than just its
// spelling. "Meal Tax" and "Accrued Meal Tax" are different accounts with different
// balances — fuzzy matching must never bridge a query and a candidate that disagree
// on which of these modifiers they carry, no matter how similar the remaining words
// are. This list is generic accounting vocabulary, not tied to any specific account.
// "net operating" / "non operating" added — CONFIRMED BUG this fixes: "Net
// Operating Income" (a computed subtotal) and "Non-Operating Income" (a real,
// unrelated line item) are opposite concepts that share every word except
// "Net"/"Non", scoring 0.90 similarity — exactly the fuzzy-match threshold —
// and colliding onto the same generated hierarchy path. Standard financial-
// statement vocabulary, not tied to any specific client's chart of accounts.
const MODIFIER_PHRASES = ["non current", "long term", "short term", "net operating", "non operating"];
const MODIFIER_WORDS = [
  "accrued", "deferred", "prepaid", "prepayment", "provision", "allowance",
  "reserve", "unearned", "payable", "receivable", "amortization", "amortized",
  "depreciation", "accumulated", "restricted", "current", "impairment",
  "valuation", "clearing", "suspense", "estimated", "contra",
];

/** Set of accounting-modifier phrases/words present in a norm()-ed account name. */
function extractModifiers(normalized) {
  let s = ` ${normalized} `;
  const found = new Set();
  for (const phrase of MODIFIER_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(" ", "\\s+")}\\b`);
    if (re.test(s)) { found.add(phrase); s = s.replace(re, " "); }
  }
  for (const word of MODIFIER_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(s)) found.add(word);
  }
  return found;
}

/** True only when both names carry exactly the same set of accounting modifiers. */
function sameModifiers(a, b) {
  if (a.size !== b.size) return false;
  for (const m of a) if (!b.has(m)) return false;
  return true;
}

/** Name -> account_id[] map (+ __num__<n> keys), for exact multi-alias lookups. */
function buildMappings(leaves) {
  const map = new Map();
  for (const acc of leaves || []) {
    const names = [acc.adjusted_name, acc.account_name, acc.base_account].filter(Boolean);
    for (const name of names) {
      const key = norm(name);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(acc.id)) map.get(key).push(acc.id);
    }
    if (acc.account_number) {
      const numKey = `__num__${String(acc.account_number).trim()}`;
      if (!map.has(numKey)) map.set(numKey, []);
      if (!map.get(numKey).includes(acc.id)) map.get(numKey).push(acc.id);
    }
  }
  return map;
}

// ─── Multi-strategy fuzzy fallback matcher ────────────────────────────────────

function buildFuzzyLookup(leaves) {
  const exact  = new Map();
  const strict = new Map();
  const byNum  = new Map();
  for (const acc of leaves) {
    const names = [acc.adjusted_name, acc.account_name, acc.base_account].filter(Boolean);
    for (const name of names) {
      const k1 = norm(name);
      if (k1 && !exact.has(k1))  exact.set(k1, acc.id);
      const k2 = normStrict(name);
      if (k2 && !strict.has(k2)) strict.set(k2, acc.id);
    }
    if (acc.account_number) {
      const nk = String(acc.account_number).trim();
      if (nk && !byNum.has(nk)) byNum.set(nk, acc.id);
    }
  }
  return { exact, strict, byNum };
}

function fuzzyMatch(lookup, name, accountNumber) {
  const k1 = norm(name);
  if (lookup.exact.has(k1)) return { id: lookup.exact.get(k1), confidence: 1.0 };

  if (accountNumber) {
    const nk = String(accountNumber).trim();
    if (lookup.byNum.has(nk)) return { id: lookup.byNum.get(nk), confidence: 1.0 };
  }

  const k2 = normStrict(name);
  if (k2 && lookup.strict.has(k2)) return { id: lookup.strict.get(k2), confidence: 0.95 };

  // Word-set Jaccard similarity with a lowered threshold of 0.50 to catch more valid
  // accounts (e.g. "Cost of Goods Sold" vs "Cost of Sales", "Rent Expense" vs "Rent").
  // Also bonuses for: containment (substring), shared first word, shared last word.
  //
  // Hard gate: a candidate whose accounting-modifier set differs from the query's
  // (Accrued / Prepaid / Payable / Current / …) is never a fuzzy candidate — those
  // words change the account's meaning, not just its spelling. See extractModifiers.
  // singularize() only affects word-overlap scoring here — never the
  // exact/strict tiers above — so it can only help two already-similar names
  // match a little more often (e.g. "Rent Expenses" vs "Rent Expense").
  const queryModifiers = extractModifiers(k1);
  const words1 = new Set(k1.split(" ").filter(w => w.length > 1).map(singularize));
  const arr1   = [...words1];
  let bestId = null, bestScore = 0;
  for (const [k, id] of lookup.exact) {
    if (!sameModifiers(queryModifiers, extractModifiers(k))) continue;
    const words2 = new Set(k.split(" ").filter(w => w.length > 1).map(singularize));
    if (!words2.size || !words1.size) continue;
    const inter = arr1.filter(w => words2.has(w)).length;
    const union = new Set([...arr1, ...words2]).size;
    const jaccard = union > 0 ? inter / union : 0;
    const containsBonus  = (k1.includes(k) || k.includes(k1)) ? 0.10 : 0;
    const firstWordBonus = (arr1[0] && arr1[0] === [...words2][0]) ? 0.05 : 0;
    const lastWordBonus  = (arr1[arr1.length - 1] && arr1[arr1.length - 1] === [...words2][words2.size - 1]) ? 0.05 : 0;
    const total = Math.min(jaccard + containsBonus + firstWordBonus + lastWordBonus, 1.0);
    if (total > bestScore && total >= 0.50) { bestScore = total; bestId = id; }
  }
  if (bestId) return { id: bestId, confidence: bestScore };

  return null;
}

module.exports = {
  norm,
  normNoAlias,
  normStrict,
  extractModifiers,
  sameModifiers,
  buildMappings,
  buildFuzzyLookup,
  fuzzyMatch,
  // exported for unit testing
  stripDeletedSuffix,
  expandAbbreviations,
  singularize,
};
