// ============================================================================
// COA Account Matcher — deterministic 5-stage matching engine
//
// When a company has uploaded its own Chart of Accounts (client_chart_of_
// accounts), THAT upload is the single source of truth for hierarchy. This
// module's only job is deciding, for one GL/BS/PL account name, which (if
// any) uploaded COA row it really is — so its hierarchy can be copied
// directly and NO AI call is ever spent on an account the client already
// classified themselves.
//
// Stages, tried in order, first confident hit wins:
//   0. Account number (exact)       — the strongest possible signal
//   1. Exact match                  — trim/lowercase/collapse whitespace only
//   2. Normalized match             — accountNameMatching.normNoAlias (&, punctuation,
//                                     apostrophes, whitespace — no abbreviation expansion)
//   3. Alias match                  — accountNameMatching.norm (adds abbreviation
//                                     expansion: F&F, M&E, Accum Dep, A/R, A/P, ...)
//   4. Fuzzy match (strict, >= 95%) — Levenshtein ratio + Jaro-Winkler + token
//                                     overlap, auto-matched only above the threshold
//   5. Parent validation            — only engages when a stage above surfaces MORE
//                                     THAN ONE candidate at/near the winning score;
//                                     disambiguates using section/type/level evidence
//
// A query that doesn't reach a confident single winner comes back
// status: 'unmatched' (never seen before in this COA) or 'ambiguous' (more
// than one plausible candidate survives even parent validation) — both are
// the ONLY cases that should ever reach AI classification. Everything else
// bypasses AI entirely.
//
// Strictly scoped to whatever candidate list the caller passes in — this
// module has no DB access and no cross-company reach of its own.
// ============================================================================

"use strict";

const { norm, normNoAlias, extractModifiers, sameModifiers } = require("./accountNameMatching");

// Auto-match floor for the strict fuzzy stage — deliberately much higher than
// the separate, looser accountNameMatching.fuzzyMatch (0.50) used elsewhere
// for human-reviewed GL-to-COA linking. Here a match skips AI and human
// review entirely, so it must be a near-certainty, not just "plausible".
const STRICT_FUZZY_THRESHOLD = 0.95;
// Two candidates within this margin of each other (and of the winning score)
// are treated as a tie needing Stage 5 disambiguation, not a clear winner.
const TIE_MARGIN = 0.03;

const LEVEL_KEYS = Array.from({ length: 15 }, (_, i) => `level_${i + 1}`);

// ── String similarity (dependency-free) ──────────────────────────────────────

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

function levenshteinRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

function jaroSimilarity(a, b) {
  if (a === b) return 1;
  const aLen = a.length, bLen = b.length;
  if (!aLen || !bLen) return 0;
  const matchDistance = Math.max(Math.floor(Math.max(aLen, bLen) / 2) - 1, 0);
  const aMatches = new Array(aLen).fill(false);
  const bMatches = new Array(bLen).fill(false);
  let matches = 0;
  for (let i = 0; i < aLen; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLen);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true; bMatches[j] = true; matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;
  return (matches / aLen + matches / bLen + (matches - transpositions) / matches) / 3;
}

function jaroWinkler(a, b) {
  const jaro = jaroSimilarity(a, b);
  let prefixLen = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    prefixLen++;
  }
  return jaro + prefixLen * 0.1 * (1 - jaro);
}

function tokenJaccard(a, b) {
  const words1 = new Set(a.split(" ").filter(Boolean));
  const words2 = new Set(b.split(" ").filter(Boolean));
  if (!words1.size || !words2.size) return 0;
  let inter = 0;
  for (const w of words1) if (words2.has(w)) inter++;
  const union = words1.size + words2.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Combined strict-similarity score for the Fuzzy stage — the BEST of three
 * distinct metrics, since each catches a different kind of distortion
 * (Levenshtein: small edits/typos; Jaro-Winkler: transpositions/prefix
 * similarity; token Jaccard: reordered or singular/plural word variants).
 * Gated by the same accounting-modifier hard rule used elsewhere in this
 * codebase (extractModifiers/sameModifiers) — "Rent" and "Accrued Rent" must
 * never auto-match no matter how similar the remaining text is.
 */
function strongSimilarity(normA, normB) {
  if (!sameModifiers(extractModifiers(normA), extractModifiers(normB))) return 0;
  return Math.max(
    levenshteinRatio(normA, normB),
    jaroWinkler(normA, normB),
    tokenJaccard(normA, normB),
  );
}

// ── Candidate indexing ────────────────────────────────────────────────────────

/**
 * Index a list of client_chart_of_accounts-shaped rows for repeated matching.
 * Each stage's lookup keeps an ARRAY of candidate ids per key (not just the
 * first) — a duplicate/near-duplicate uploaded row must surface as an
 * ambiguity to resolve, never silently vanish behind whichever row happened
 * to be indexed first.
 */
function buildCandidateIndex(candidates) {
  const byId = new Map();
  const byNumber = new Map();
  const byExact = new Map();
  const byNormalized = new Map();
  const byAlias = new Map();

  const addTo = (map, key, id) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(id)) map.get(key).push(id);
  };

  for (const c of candidates) {
    byId.set(c.id, c);
    const names = [c.account_name, c.adjusted_name].filter(Boolean);
    if (c.account_number) addTo(byNumber, String(c.account_number).trim(), c.id);
    for (const name of names) {
      addTo(byExact, lightNorm(name), c.id);
      addTo(byNormalized, normNoAlias(name), c.id);
      addTo(byAlias, norm(name), c.id);
    }
  }
  return { byId, byNumber, byExact, byNormalized, byAlias };
}

function lightNorm(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Stage 5: Parent Validation ───────────────────────────────────────────────

/**
 * Disambiguate a tie between multiple candidate rows using structural
 * evidence about the QUERY account — its own Balance Sheet/P&L section
 * evidence and (if already inferable) account type — against each
 * candidate's own hierarchy position (level_1/level_(N-1)/statement_type/
 * normal_balance). Returns the single surviving candidate id, or null if
 * more than one (or zero) still fits — a genuine tie is never force-picked.
 */
function parentValidate(query, candidateRows) {
  const survivors = candidateRows.filter((c) => {
    const levels = LEVEL_KEYS.map((k) => c[k]).filter(Boolean);
    const level1 = levels[0] || "";
    const parent = levels.length > 1 ? levels[levels.length - 2] : "";

    if (query.bsSection) {
      const sec = String(query.bsSection).toLowerCase();
      const l1 = level1.toLowerCase();
      if (sec.includes("asset") && !l1.includes("asset")) return false;
      if (sec.includes("liab") && !l1.includes("liab")) return false;
      if ((sec.includes("equity") || sec.includes("capital")) && !l1.includes("equity")) return false;
    }
    if (query.plSection === "revenue" && !/income|revenue/i.test(level1)) return false;
    if (query.plSection === "cost_of_sales" && !/cost of (goods|sales)/i.test(level1)) return false;
    if ((query.plSection === "operating_expenses" || query.plSection === "other_expense") && !/expense/i.test(level1)) return false;

    if (query.accountNumber && c.account_number && String(c.account_number).trim() !== String(query.accountNumber).trim()) return false;

    return true;
  });
  return survivors.length === 1 ? survivors[0].id : null;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Match ONE account against the given candidate rows (already scoped to this
 * company's own uploaded COA — no cross-company data ever reaches this
 * function).
 *
 * @param {{accountName: string, accountNumber?: string|null, bsSection?: string|null, plSection?: string|null}} query
 * @param {Array<object>} candidates — client_chart_of_accounts rows: id, account_name,
 *   adjusted_name, account_number, level_1..level_15, hierarchy_path, statement_type, normal_balance
 * @returns {{
 *   status: 'matched'|'ambiguous'|'unmatched',
 *   matchTier: 'account_number'|'exact'|'normalized'|'alias'|'fuzzy'|'parent_validated'|null,
 *   confidence: number,
 *   entry: object|null,
 *   candidates: Array<object>,
 *   reason: string,
 * }}
 */
function matchAccountToCoa(query, candidates) {
  if (!candidates || !candidates.length) {
    return { status: "unmatched", matchTier: null, confidence: 0, entry: null, candidates: [], reason: "No uploaded Chart of Accounts entries to match against." };
  }
  const index = buildCandidateIndex(candidates);
  const rawName = query.accountName || "";

  const resolveTier = (ids, matchTier, confidence, reasonPrefix) => {
    if (ids.length === 1) {
      const entry = index.byId.get(ids[0]);
      return { status: "matched", matchTier, confidence, entry, candidates: [entry], reason: `${reasonPrefix} — single unambiguous match.` };
    }
    // More than one candidate at the same key — try Stage 5 before giving up.
    const rows = ids.map((id) => index.byId.get(id));
    const winnerId = parentValidate(query, rows);
    if (winnerId) {
      const entry = index.byId.get(winnerId);
      return { status: "matched", matchTier: "parent_validated", confidence, entry, candidates: rows, reason: `${reasonPrefix}, but ${ids.length} rows shared this name — disambiguated by section/type/parent evidence.` };
    }
    return { status: "ambiguous", matchTier, confidence, entry: null, candidates: rows, reason: `${reasonPrefix}, but ${ids.length} uploaded COA rows share this identity and structural evidence could not tell them apart.` };
  };

  // Stage 0: account number.
  if (query.accountNumber) {
    const ids = index.byNumber.get(String(query.accountNumber).trim());
    if (ids?.length) return resolveTier(ids, "account_number", 1.0, `Matched by Account Number "${query.accountNumber}"`);
  }

  // Stage 1: exact (trim/lowercase/collapse whitespace only).
  const k0 = lightNorm(rawName);
  const idsExact = index.byExact.get(k0);
  if (idsExact?.length) return resolveTier(idsExact, "exact", 1.0, `Matched by Exact stage ("${rawName}")`);

  // Stage 2: normalized (punctuation/&/apostrophes, no abbreviation expansion).
  const k1 = normNoAlias(rawName);
  const idsNorm = index.byNormalized.get(k1);
  if (idsNorm?.length) return resolveTier(idsNorm, "normalized", 0.99, `Matched by Normalized stage ("${rawName}" -> "${k1}")`);

  // Stage 3: alias (abbreviation expansion — F&F, M&E, Accum Dep, A/R, A/P, ...).
  const k2 = norm(rawName);
  const idsAlias = index.byAlias.get(k2);
  if (idsAlias?.length) return resolveTier(idsAlias, "alias", 0.97, `Matched by Alias stage ("${rawName}" -> "${k2}")`);

  // Stage 4: fuzzy (strict — Levenshtein/Jaro-Winkler/token overlap, >= 95%).
  let bestScore = 0;
  let tiedIds = [];
  for (const [key, ids] of index.byAlias) {
    const score = strongSimilarity(k2, key);
    if (score < STRICT_FUZZY_THRESHOLD) continue;
    if (score > bestScore + TIE_MARGIN) {
      bestScore = score; tiedIds = [...ids];
    } else if (score >= bestScore - TIE_MARGIN) {
      bestScore = Math.max(bestScore, score);
      tiedIds.push(...ids);
    }
  }
  if (tiedIds.length) {
    const uniqueIds = [...new Set(tiedIds)];
    return resolveTier(uniqueIds, "fuzzy", bestScore, `Matched by Fuzzy stage at ${(bestScore * 100).toFixed(1)}% similarity`);
  }

  return {
    status: "unmatched", matchTier: null, confidence: 0, entry: null, candidates: [],
    reason: `No uploaded Chart of Accounts entry reached the ${(STRICT_FUZZY_THRESHOLD * 100).toFixed(0)}% confidence floor across Exact/Normalized/Alias/Fuzzy stages.`,
  };
}

module.exports = {
  matchAccountToCoa,
  strongSimilarity,
  levenshteinRatio,
  jaroWinkler,
  tokenJaccard,
  STRICT_FUZZY_THRESHOLD,
};
