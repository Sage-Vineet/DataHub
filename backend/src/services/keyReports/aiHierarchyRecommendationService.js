// ============================================================================
// AI Reasonableness Check / Reclassification Recommendation Engine
//
// Runs strictly AFTER the deterministic Chart of Accounts has been fully
// generated and validated. This layer is ADVISORY ONLY:
//
//   - It NEVER generates the COA.
//   - It NEVER runs classification; the deterministic result is the input.
//   - It NEVER writes to chart_of_accounts during analysis.
//   - It NEVER touches balances, GL mappings, Trial Balance or report totals.
//   - It NEVER auto-applies. Every proposal is stored with status 'pending'
//     and only a user can move it to applied/rejected.
//
// Its job is a SECOND-PASS accounting reasonableness review: read the
// already-authoritative hierarchy and flag accounts whose placement is
// technically possible but reads wrong on a financial statement — the classic
// cases being Interest Income presented inside operating revenue, Interest
// Expense inside operating expenses, and Gain/Loss on disposal of fixed assets
// presented as ordinary sales/opex.
//
// Applying a recommendation goes through chartOfAccountsService
// .updateAccountHierarchy() — the SAME function the manual "Edit Chart of
// Accounts" grid uses. There is no second hierarchy writer, no second
// classification engine, and no hardcoded account-name → section table: the
// target section is always chosen from the company's OWN document-driven
// category structure, and where no suitable section exists the recommendation
// is explicitly marked AI_REASONABLENESS so the reviewer knows it was derived
// rather than matched.
// ============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getGeminiModels } = require("../../config/geminiModels");
const { supabase } = require("../../db");

const GEMINI_MODELS = getGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_LEVELS = 15;
// Smaller than the old 40: each account now carries real context (number,
// system id, siblings, section) so the prompt is denser per row.
const BATCH_SIZE = 25;
const TABLE = "key_report_coa_hierarchy_recommendations";

const CONFIDENCE_BANDS = new Set(["HIGH", "MEDIUM", "LOW"]);
const BAND_SCORE = { HIGH: 0.95, MEDIUM: 0.75, LOW: 0.5 };
const KINDS = new Set(["ROLLUP_INSERT", "HIERARCHY_MOVE", "RECLASSIFY"]);
const ACCOUNT_TYPES = new Set(["income", "cogs", "expense", "asset", "liability", "equity"]);
const STATEMENT_TYPES = new Set(["profit_loss", "balance_sheet"]);

// Every account type is now in scope. The original engine reviewed P&L only,
// which made a whole class of real problems structurally invisible — a
// retained-earnings or equity account sitting in the P&L, or a P&L account
// sitting on the Balance Sheet, could never be flagged. Selection here only
// decides WHICH already-classified accounts get LOOKED AT; it never implies
// anything about what they should be.
const REVIEWABLE_TYPES = ACCOUNT_TYPES;

// ── Gemini plumbing (unchanged behaviour: fail-soft, model fallback) ────────
async function callGeminiText(prompt) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  let lastError = null;
  for (const modelName of GEMINI_MODELS) {
    let retries = 2;
    while (retries > 0) {
      try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([{ text: prompt }]);
        return { text: result.response.text(), model: modelName };
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err);
        const isQuota = msg.includes("429") || msg.toLowerCase().includes("quota");
        const isNotFound = msg.includes("404") || msg.toLowerCase().includes("not found");
        console.warn(`[CoaReasonableness] Model ${modelName} failed: ${msg}`);
        if (isNotFound) break;
        if (isQuota && retries > 1) { await sleep(3000); retries -= 1; } else break;
      }
    }
  }
  throw new Error(`AI reasonableness call failed: ${String(lastError?.message || "unknown")}`);
}

function parseJsonFromText(text = "") {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

// chartOfAccountsService's padLevelsWithLeafPropagation fills every level past
// a leaf's real depth by repeating its deepest real value, so every row has a
// full 15-column shape. Collapse those trailing repeats back to their single
// real occurrence — otherwise every leaf looks several levels deeper than it
// is, which corrupts both what the AI sees and how a recommendation is applied.
function columnsToLevels(row) {
  const levels = [];
  for (let i = 0; i < MAX_LEVELS; i += 1) levels.push(row[`level_${i + 1}`] || null);
  const nonNull = levels.filter(Boolean);
  while (nonNull.length > 1 && nonNull[nonNull.length - 1] === nonNull[nonNull.length - 2]) {
    nonNull.pop();
  }
  return nonNull;
}

function displayName(row) {
  return row.adjusted_name || row.base_account || row.account_name;
}

const norm = (s) => String(s || "").trim().toLowerCase();
const samePath = (a, b) => JSON.stringify((a || []).map(norm)) === JSON.stringify((b || []).map(norm));

/** A stable identity for "the account's classification as the AI saw it",
 * used to detect that the COA has moved on since a recommendation was made. */
function classificationFingerprint({ hierarchy, accountType, statementType }) {
  return JSON.stringify({ h: (hierarchy || []).map(norm), t: norm(accountType), s: norm(statementType) });
}

// ── Loading the already-generated COA ───────────────────────────────────────

const LEAF_COLS = [
  "id", "account_name", "adjusted_name", "base_account", "account_number", "system_id",
  "account_type", "statement_type", "hierarchy_path", "metadata", "parent_account_id",
  ...Array.from({ length: MAX_LEVELS }, (_, i) => `level_${i + 1}`),
].join(", ");

/**
 * Every active row for this version, split into posting leaves and the
 * document-driven category (is_group) nodes.
 *
 * A leaf the user — or a previously applied recommendation — already
 * customized is excluded from review: its hierarchy is intentionally sticky,
 * the same rule the COA generator itself applies on regenerate. The category
 * nodes are NOT filtered that way; they are the company's own section
 * structure and are what a recommendation must target.
 */
async function loadVersionCoa(versionId) {
  const { data, error } = await supabase
    .from("chart_of_accounts")
    .select(LEAF_COLS)
    .eq("version_id", versionId)
    .eq("is_active", true);
  if (error) throw error;

  const rows = data || [];
  const categories = rows.filter((r) => r.metadata?.is_group);
  const leaves = rows.filter((r) => !r.metadata?.is_group);
  const reviewable = leaves.filter((r) =>
    !r.metadata?.user_modified && REVIEWABLE_TYPES.has(r.account_type));

  return { rows, categories, leaves, reviewable };
}

/**
 * The company's OWN section structure, per statement — derived from the
 * category nodes the deterministic generator already built from the uploaded
 * documents. This is what makes a recommendation document-driven rather than
 * hardcoded: the AI is told which sections actually exist and asked to choose
 * among them.
 */
function buildSectionCatalog(categories) {
  const byStatement = { profit_loss: [], balance_sheet: [] };
  for (const c of categories) {
    const path = columnsToLevels(c);
    if (!path.length) continue;
    const key = STATEMENT_TYPES.has(c.statement_type) ? c.statement_type : null;
    if (!key) continue;
    byStatement[key].push(path);
  }
  for (const key of Object.keys(byStatement)) {
    const seen = new Set();
    byStatement[key] = byStatement[key]
      .filter((p) => { const k = p.map(norm).join(" > "); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.join(" > ").localeCompare(b.join(" > ")));
  }
  return byStatement;
}

/** Accounts sharing an immediate parent — the context that distinguishes a
 * genuinely misplaced account from one whose neighbours make its placement
 * sensible (spec §17: "Gain sharing revenue" must not be treated like
 * "Gain on Sale of Assets"). */
function buildSiblingIndex(leaves) {
  const byParent = new Map();
  for (const r of leaves) {
    const k = r.parent_account_id || "__root__";
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(displayName(r));
  }
  return byParent;
}

function toReviewInput(row, siblingIndex) {
  const hierarchy = columnsToLevels(row);
  const siblings = (siblingIndex.get(row.parent_account_id || "__root__") || [])
    .filter((n) => n !== displayName(row));
  return {
    id: row.id,
    systemId: row.system_id || null,
    accountNumber: row.account_number || null,
    name: displayName(row),
    accountType: row.account_type,
    statementType: row.statement_type,
    hierarchy,
    parent: hierarchy.length >= 2 ? hierarchy[hierarchy.length - 2] : null,
    siblings: siblings.slice(0, 12),
  };
}

// ── The dedicated reasonableness prompt ─────────────────────────────────────
// Deliberately NOT the document-extraction prompt, and it never asks Gemini to
// regenerate or reclassify the COA. It asks one question per account: does
// this placement read correctly on a financial statement, and if not, which of
// THIS COMPANY'S existing sections should it move to?
function buildReasonablenessPrompt(batch, sections, statementType) {
  const accountLines = batch.map((a) => JSON.stringify({
    id: a.id,
    systemId: a.systemId,
    accountNumber: a.accountNumber,
    accountName: a.name,
    accountType: a.accountType,
    statementType: a.statementType,
    currentHierarchy: a.hierarchy,
    immediateParent: a.parent,
    siblings: a.siblings,
  }));

  const sectionLines = (sections || []).slice(0, 200).map((p) => `  ${p.join(" > ")}`);

  return `You are a CPA performing a REASONABLENESS REVIEW of an already-generated Chart of Accounts for one company. The classification and hierarchy you are shown were produced by a deterministic engine and are the source of truth. You are NOT being asked to regenerate, re-classify, or re-build anything.

Your ONLY job: identify accounts whose current placement is technically possible but would read INCORRECTLY on a financial statement, and say where in THIS COMPANY'S OWN existing structure they belong instead.

THE ACCOUNTING PRESENTATION PRINCIPLE you are applying (this is intent, NOT a structure to impose):
non-operating items must not be presented inside operating results. Operating revenue and operating expenses determine Operating Income; interest, investment income, and gains/losses on disposal of assets belong below it, with taxes below that, arriving at Net Income.

STRONG CANDIDATES (only when context agrees):
- Interest Income / Dividend Income / Investment Income / Rental Income presented inside operating revenue or sales
- Interest Expense / Interest Paid / Loan Interest / Finance Charges / Financing Costs presented inside operating expenses
- Gain or Loss on Sale/Disposal of Assets, Fixed Assets, Equipment or Investments presented as ordinary revenue or ordinary operating expense
- Foreign exchange gain/loss, unrealized gain/loss presented inside operating results
- Income Tax / Corporate Tax expense presented as an ordinary operating expense
- Owner distributions presented as an expense, or owner contributions presented as revenue
- Retained Earnings or another equity account presented as a P&L account
- A Balance Sheet account presented as a P&L account, or vice versa

DO NOT flag an account merely because its name contains one of those words. Judge from the whole context you are given — the account name, its number, its current hierarchy, its immediate parent, and its sibling accounts. Examples of correct restraint:
- "Gain sharing revenue" is operating revenue, NOT a gain on asset disposal. Leave it.
- "Interest-related operating revenue" at a lender is operating revenue. Leave it.
- An account already sitting under a clearly non-operating section is correctly placed. Leave it.
- A vague name such as "Other Charges" with no corroborating context is at most LOW confidence — prefer no recommendation.

THIS COMPANY'S EXISTING ${statementType === "balance_sheet" ? "BALANCE SHEET" : "PROFIT & LOSS"} SECTIONS (choose a target from these wherever one fits — do not invent a section when a suitable one exists):
${sectionLines.length ? sectionLines.join("\n") : "  (none available)"}

ACCOUNTS TO REVIEW (one JSON object per line):
${accountLines.join("\n")}

For each account you are recommending a change for, return the COMPLETE recommended hierarchy as an array of labels from the top level down to and INCLUDING the account's own name as the final element. The account's own name must be reproduced exactly as given — you are never renaming an account.

Set "kind":
  "HIERARCHY_MOVE"  the account stays the same type but belongs under a different section
  "ROLLUP_INSERT"   the account is in the right area but needs one more specific grouping label above it
  "RECLASSIFY"      the account is on the wrong statement entirely; also set recommendedAccountType and recommendedStatementType

Set "confidence" to "HIGH" only when the account name AND the surrounding context clearly conflict with the current placement. Use "MEDIUM" when the name is indicative but the context is not decisive, and "LOW" when it is a judgement call.

Return STRICT JSON only — no markdown, no prose. If nothing is worth recommending, return {"recommendations": []}.
{
  "recommendations": [
    {
      "id": "<echo the account id exactly>",
      "kind": "HIERARCHY_MOVE",
      "recommendedHierarchy": ["<top level>", "...", "<the account's own name>"],
      "recommendedAccountType": null,
      "recommendedStatementType": null,
      "confidence": "HIGH",
      "reason": "<one sentence explaining the presentation problem, in plain language for an accountant>"
    }
  ]
}`;
}

// ── Deterministic post-processing of whatever the model returns ─────────────
// Nothing free-form is ever persisted: every field is validated, and anything
// that cannot be trusted is dropped rather than stored.

/** Is the proposed parent path one of the company's real, document-driven
 * sections? Decided HERE rather than trusting the model to self-report, so
 * `source` is always accurate. */
function resolveSource(recommendedHierarchy, sectionPaths) {
  const parentPath = (recommendedHierarchy || []).slice(0, -1);
  if (!parentPath.length) return "AI_REASONABLENESS";
  const key = parentPath.map(norm).join(" > ");
  const known = new Set((sectionPaths || []).map((p) => p.map(norm).join(" > ")));
  return known.has(key) ? "DOCUMENT_MATCH" : "AI_REASONABLENESS";
}

/** What a change would actually move — used to keep the review list to things
 * that matter rather than hundreds of cosmetic observations. */
function resolveImpact(kind, account, recommendedHierarchy) {
  if (kind === "RECLASSIFY") return "CLASSIFICATION";
  const before = (account.hierarchy || []).slice(0, -1).map(norm).join(" > ");
  const after = (recommendedHierarchy || []).slice(0, -1).map(norm).join(" > ");
  if (before === after) return "PRESENTATION";
  // The account moves to a different branch: this is what shifts Operating
  // Income / Other Income / EBITDA subtotals on the P&L, or which section of
  // the Balance Sheet a figure lands in.
  return account.statementType === "balance_sheet" ? "BALANCE_SHEET_SECTION" : "OPERATING_RESULT";
}

/**
 * Validate one model proposal against the account it claims to be about.
 * Returns null when the proposal cannot be trusted.
 */
function normalizeProposal(raw, account, sectionPaths) {
  if (!raw || !account) return null;

  const kind = KINDS.has(String(raw.kind || "").trim()) ? String(raw.kind).trim() : "HIERARCHY_MOVE";
  const band = String(raw.confidence || "").trim().toUpperCase();
  if (!CONFIDENCE_BANDS.has(band)) return null;

  if (!Array.isArray(raw.recommendedHierarchy)) return null;
  const hierarchy = raw.recommendedHierarchy.map((s) => String(s || "").trim());
  // A blank level means the model produced a malformed path. Reject it rather
  // than silently compacting it — quietly repairing a bad answer would change
  // its meaning, and nothing free-form is allowed to become a recommendation.
  if (hierarchy.some((l) => !l)) return null;
  // Must be a usable path that still ends at THIS account: a recommendation is
  // never allowed to rename an account or to swallow it into another one.
  if (hierarchy.length < 2 || hierarchy.length > MAX_LEVELS) return null;
  if (norm(hierarchy[hierarchy.length - 1]) !== norm(account.name)) return null;
  // A no-op proposal is noise, not a recommendation.
  if (samePath(hierarchy, account.hierarchy)) return null;
  // The account can never end up inside itself.
  if (hierarchy.slice(0, -1).some((l) => norm(l) === norm(account.name))) return null;

  let recommendedAccountType = null;
  let recommendedStatementType = null;
  if (kind === "RECLASSIFY") {
    recommendedAccountType = String(raw.recommendedAccountType || "").trim().toLowerCase() || null;
    recommendedStatementType = String(raw.recommendedStatementType || "").trim().toLowerCase() || null;
    // A reclassification with no valid target type is meaningless — and must
    // never be silently downgraded to a hierarchy move, which would apply a
    // P&L path to a Balance Sheet account.
    if (!ACCOUNT_TYPES.has(recommendedAccountType)) return null;
    if (recommendedStatementType && !STATEMENT_TYPES.has(recommendedStatementType)) return null;
    if (recommendedAccountType === account.accountType) return null;
  }

  return {
    accountId: account.id,
    kind,
    recommendedHierarchy: hierarchy,
    // The deepest new label, kept because the table's uniqueness key
    // (version_id, account_id, recommended_rollup) is what makes a re-run
    // upsert onto the same row instead of duplicating.
    recommendedRollup: hierarchy[hierarchy.length - 2],
    recommendedParent: hierarchy.length >= 3 ? hierarchy[hierarchy.length - 3] : null,
    recommendedAccountType,
    recommendedStatementType,
    confidenceBand: band,
    confidence: BAND_SCORE[band],
    source: resolveSource(hierarchy, sectionPaths),
    impact: resolveImpact(kind, account, hierarchy),
    reason: String(raw.reason || "").trim() || null,
  };
}

/**
 * Keep only recommendations that can materially affect a statement (spec §12).
 * A LOW-confidence cosmetic regrouping is exactly the kind of noise that makes
 * a review list unusable; a LOW-confidence RECLASSIFY is still worth a human
 * look because it changes which statement a number appears on.
 */
function isMaterial(p) {
  if (p.kind === "RECLASSIFY") return true;
  if (p.confidenceBand === "LOW") return false;
  return p.impact !== "PRESENTATION" || p.confidenceBand === "HIGH";
}

// ── Generation ──────────────────────────────────────────────────────────────

/**
 * Analyze the fully-generated COA for one version and store reasonableness
 * recommendations. Never writes to chart_of_accounts.
 *
 * Fail-soft by contract: any failure here (no API key, Gemini down, a bad
 * batch, a malformed response) leaves the COA and every downstream report
 * completely unaffected — the caller logs and carries on. "COA generated
 * successfully + reasonableness check unavailable" is a valid state.
 */
async function generateRecommendations(companyId, versionId) {
  const summary = {
    accountsReviewed: 0, recommendations: 0,
    highConfidence: 0, mediumConfidence: 0, lowConfidence: 0,
    applied: 0, rejected: 0, aiUnavailable: false,
  };

  const { categories, leaves, reviewable } = await loadVersionCoa(versionId);
  const sections = buildSectionCatalog(categories);
  const siblingIndex = buildSiblingIndex(leaves);

  const reviewInput = reviewable
    .map((r) => toReviewInput(r, siblingIndex))
    // Need at least [parent, ownName] for "is this placed correctly" to mean
    // anything at all.
    .filter((r) => r.hierarchy.length >= 2);
  summary.accountsReviewed = reviewInput.length;

  if (!reviewInput.length) { logSummary(summary); return summary; }

  if (!process.env.GEMINI_API_KEY) {
    summary.aiUnavailable = true;
    console.warn("[CoaReasonableness] GEMINI_API_KEY not set — skipping reasonableness check. COA is unaffected.");
    logSummary(summary);
    return summary;
  }

  const byId = new Map(reviewInput.map((r) => [r.id, r]));
  const proposals = [];
  let modelUsed = null;
  let batchesAttempted = 0;
  let batchesFailed = 0;

  // Batched per statement type so each prompt carries the section catalog that
  // is actually relevant to the accounts in it.
  for (const statementType of ["profit_loss", "balance_sheet"]) {
    const scoped = reviewInput.filter((r) => r.statementType === statementType);
    const sectionPaths = sections[statementType] || [];
    for (let i = 0; i < scoped.length; i += BATCH_SIZE) {
      const batch = scoped.slice(i, i + BATCH_SIZE);
      batchesAttempted += 1;
      try {
        const { text, model } = await callGeminiText(buildReasonablenessPrompt(batch, sectionPaths, statementType));
        modelUsed = model;
        const parsed = parseJsonFromText(text);
        const rows = Array.isArray(parsed?.recommendations) ? parsed.recommendations : [];
        for (const r of rows) {
          const account = byId.get(String(r?.id || "").trim());
          if (!account) continue;
          const p = normalizeProposal(r, account, sectionPaths);
          if (p && isMaterial(p)) proposals.push({ ...p, account });
        }
      } catch (err) {
        batchesFailed += 1;
        console.warn(`[CoaReasonableness] ${statementType} batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
      }
    }
  }

  if (batchesAttempted > 0 && batchesFailed === batchesAttempted) summary.aiUnavailable = true;

  for (const p of proposals) {
    // `status` is deliberately omitted: on conflict Postgres only updates the
    // columns present here, so a row the user already decided keeps its status
    // — a fresh pass can never silently reopen a settled decision.
    const { error } = await supabase.from(TABLE).upsert({
      version_id: versionId,
      company_id: companyId,
      account_id: p.accountId,
      current_hierarchy: p.account.hierarchy,
      current_account_type: p.account.accountType,
      current_statement_type: p.account.statementType,
      kind: p.kind,
      recommended_hierarchy: p.recommendedHierarchy,
      recommended_rollup: p.recommendedRollup,
      recommended_parent: p.recommendedParent,
      recommended_account_type: p.recommendedAccountType,
      recommended_statement_type: p.recommendedStatementType,
      confidence: p.confidence,
      confidence_band: p.confidenceBand,
      source: p.source,
      impact: p.impact,
      reason: p.reason,
      ai_model: modelUsed,
      updated_at: new Date().toISOString(),
    }, { onConflict: "version_id,account_id,recommended_rollup", ignoreDuplicates: false });

    if (error) {
      console.warn(`[CoaReasonableness] Failed to store recommendation for account ${p.accountId}: ${error.message}`);
      continue;
    }
    summary.recommendations += 1;
    if (p.confidenceBand === "HIGH") summary.highConfidence += 1;
    else if (p.confidenceBand === "MEDIUM") summary.mediumConfidence += 1;
    else summary.lowConfidence += 1;
  }

  const countBy = async (statuses) => {
    const { count } = await supabase.from(TABLE)
      .select("id", { count: "exact", head: true })
      .eq("version_id", versionId).in("status", statuses);
    return count || 0;
  };
  summary.applied = await countBy(["applied", "accepted"]);
  summary.rejected = await countBy(["rejected", "ignored"]);

  logSummary(summary);
  return summary;
}

function logSummary(s) {
  console.log(
    "==================================\n" +
    "AI Reasonableness Check Summary\n" +
    "==================================\n\n" +
    `Accounts Reviewed : ${s.accountsReviewed}\n\n` +
    `Recommendations : ${s.recommendations}\n\n` +
    `High Confidence : ${s.highConfidence}\n\n` +
    `Medium Confidence : ${s.mediumConfidence}\n\n` +
    `Low Confidence : ${s.lowConfidence}\n\n` +
    `Applied : ${s.applied}\n\n` +
    `Rejected : ${s.rejected}\n\n` +
    (s.aiUnavailable ? "AI Reasonableness Check unavailable — COA unaffected.\n\n" : "") +
    "==================================",
  );
}

// ── Listing ─────────────────────────────────────────────────────────────────

// Statuses are stored lowercase (the original engine's convention, preserved
// so existing decided rows stay valid) and exposed uppercase, which is the
// contract the review UI and the API speak.
const PUBLIC_STATUS = {
  pending: "PENDING",
  applied: "APPLIED",
  rejected: "REJECTED",
  accepted: "APPLIED", // legacy: the original engine applied on accept
  ignored: "REJECTED", // legacy
};

function toPublicRecommendation(r) {
  const currentHierarchy = r.current_hierarchy || [];
  // Rows written by the original engine stored only the inserted label; derive
  // the equivalent full path so one UI can render both generations of row.
  const recommendedHierarchy = r.recommended_hierarchy
    || (r.recommended_rollup && currentHierarchy.length
      ? [...currentHierarchy.slice(0, -1), r.recommended_rollup, currentHierarchy[currentHierarchy.length - 1]]
      : null);

  return {
    id: r.id,
    recommendationId: r.id,
    accountId: r.account_id,
    accountName: r.chart_of_accounts?.adjusted_name
      || r.chart_of_accounts?.base_account
      || r.chart_of_accounts?.account_name,
    systemId: r.chart_of_accounts?.system_id || null,
    accountNumber: r.chart_of_accounts?.account_number || null,
    kind: r.kind || "ROLLUP_INSERT",
    currentStatementType: r.current_statement_type || null,
    currentAccountType: r.current_account_type || null,
    currentHierarchy,
    recommendedHierarchy,
    recommendedAccountType: r.recommended_account_type || null,
    recommendedStatementType: r.recommended_statement_type || null,
    // Retained so the existing inline badge keeps working unchanged.
    recommendedRollup: r.recommended_rollup,
    recommendedParent: r.recommended_parent,
    confidence: r.confidence,
    confidenceBand: r.confidence_band
      || (r.confidence >= 0.85 ? "HIGH" : r.confidence >= 0.7 ? "MEDIUM" : "LOW"),
    source: r.source || null,
    impact: r.impact || null,
    reason: r.reason,
    status: PUBLIC_STATUS[r.status] || String(r.status || "").toUpperCase(),
    rejectionReason: r.rejection_reason || null,
    aiModel: r.ai_model || null,
    generatedAt: r.created_at || null,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by || null,
    appliedAt: r.applied_at || null,
  };
}

async function listRecommendations(versionId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*, chart_of_accounts!inner(account_name, adjusted_name, base_account, hierarchy_path, system_id, account_number)")
    .eq("version_id", versionId)
    .order("confidence", { ascending: false });
  if (error) throw error;
  return (data || []).map(toPublicRecommendation);
}

// ── Applying ────────────────────────────────────────────────────────────────

/** The hierarchy a recommendation wants, expressed against the account's
 * CURRENT levels. Legacy ROLLUP_INSERT rows carry only the label to insert. */
function resolveTargetLevels(reco, currentLevels, ownName) {
  if (Array.isArray(reco.recommended_hierarchy) && reco.recommended_hierarchy.length >= 2) {
    return reco.recommended_hierarchy.slice(0, MAX_LEVELS);
  }
  const alreadyInserted = currentLevels.length >= 2
    && norm(currentLevels[currentLevels.length - 2]) === norm(reco.recommended_rollup);
  if (alreadyInserted) return currentLevels;
  return [...currentLevels.slice(0, -1), reco.recommended_rollup, ownName].slice(0, MAX_LEVELS);
}

/**
 * Structural safety checks that must hold before anything is written.
 * Deliberately about the SHAPE of the change — this layer changes
 * presentation/classification, never a GL amount, so no balance can move as a
 * direct result of applying one of these.
 */
function validateTargetLevels(levels, ownName) {
  const problems = [];
  if (!Array.isArray(levels) || levels.length < 2) problems.push("The recommended hierarchy is not a usable path.");
  else {
    if (levels.length > MAX_LEVELS) problems.push(`The recommended hierarchy exceeds the maximum of ${MAX_LEVELS} levels.`);
    if (levels.some((l) => !String(l || "").trim())) problems.push("The recommended hierarchy contains an empty level.");
    if (norm(levels[levels.length - 1]) !== norm(ownName)) {
      problems.push("The recommended hierarchy does not end at this account — a recommendation can never rename or absorb an account.");
    }
    if (levels.slice(0, -1).some((l) => norm(l) === norm(ownName))) {
      problems.push("The recommended hierarchy would place the account inside itself.");
    }
  }
  return problems;
}

/**
 * Apply ONE recommendation. The only place this feature touches
 * chart_of_accounts, and it does so exclusively through
 * chartOfAccountsService.updateAccountHierarchy — the same function the manual
 * grid uses, which writes level_1..15/hierarchy_path/base_account (and, for a
 * RECLASSIFY, account_type/statement_type), appends an audit entry, and marks
 * the row user_modified. It never touches balances or GL mappings.
 *
 * Refuses to apply a STALE recommendation: if the account's classification has
 * changed since the recommendation was generated, the stored proposal was
 * reasoned about a COA that no longer exists and could silently undo a newer
 * user edit. Those return a conflict for regeneration instead.
 *
 * @returns {Promise<{ok:boolean, conflict?:boolean, code?:string, message?:string, ...}>}
 */
async function applyRecommendation(recommendationId, userId = null) {
  const { data: reco, error: recoErr } = await supabase.from(TABLE).select("*").eq("id", recommendationId).single();
  if (recoErr) throw recoErr;

  if (reco.status === "applied" || reco.status === "accepted") {
    return { ok: true, alreadyApplied: true, accountId: reco.account_id };
  }
  if (reco.status === "rejected" || reco.status === "ignored") {
    return { ok: false, code: "ALREADY_REJECTED", message: "This recommendation was already rejected." };
  }

  const { data: account, error: acctErr } = await supabase
    .from("chart_of_accounts").select(LEAF_COLS).eq("id", reco.account_id).single();
  if (acctErr || !account) {
    return { ok: false, code: "ACCOUNT_NOT_FOUND", message: "The account this recommendation refers to no longer exists." };
  }

  const currentLevels = columnsToLevels(account);
  if (!currentLevels.length) {
    return { ok: false, code: "NO_HIERARCHY", message: "The account has no current hierarchy to modify." };
  }

  // ── Staleness gate ───────────────────────────────────────────────────────
  // Compare the account as it is NOW against the snapshot taken when the
  // recommendation was generated. Any drift means a regenerate or a user edit
  // has moved on, and this proposal must not be applied blindly.
  if (Array.isArray(reco.current_hierarchy) && reco.current_hierarchy.length) {
    const before = classificationFingerprint({
      hierarchy: reco.current_hierarchy,
      accountType: reco.current_account_type || account.account_type,
      statementType: reco.current_statement_type || account.statement_type,
    });
    const now = classificationFingerprint({
      hierarchy: currentLevels,
      accountType: account.account_type,
      statementType: account.statement_type,
    });
    if (before !== now) {
      return {
        ok: false,
        conflict: true,
        code: "STALE_RECOMMENDATION",
        message: "This account has changed since the recommendation was generated. Re-run the reasonableness check to get an up-to-date recommendation.",
        currentHierarchy: currentLevels,
        recommendedFor: reco.current_hierarchy,
      };
    }
  }

  const ownName = displayName(account);
  const targetLevels = resolveTargetLevels(reco, currentLevels, ownName);
  const problems = validateTargetLevels(targetLevels, ownName);
  if (problems.length) {
    return { ok: false, code: "UNSAFE_RECOMMENDATION", message: problems.join(" ") };
  }
  if (samePath(targetLevels, currentLevels)
    && !reco.recommended_account_type) {
    // Nothing to do — record the decision without a pointless write.
    await supabase.from(TABLE).update({
      status: "applied", decided_at: new Date().toISOString(), decided_by: userId,
      applied_at: new Date().toISOString(), applied_hierarchy: currentLevels,
      updated_at: new Date().toISOString(),
    }).eq("id", recommendationId);
    return { ok: true, noChange: true, accountId: reco.account_id, newLevels: currentLevels };
  }

  const patch = { levels: targetLevels, movedParent: true };
  if (reco.kind === "RECLASSIFY" && ACCOUNT_TYPES.has(reco.recommended_account_type)) {
    patch.accountType = reco.recommended_account_type;
    if (STATEMENT_TYPES.has(reco.recommended_statement_type)) {
      patch.statementType = reco.recommended_statement_type;
    }
  }

  const { updateAccountHierarchy } = require("../../services/chartOfAccountsService");
  await updateAccountHierarchy(reco.account_id, patch, userId);

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase.from(TABLE).update({
    status: "applied",
    decided_at: nowIso,
    decided_by: userId,
    applied_at: nowIso,
    applied_hierarchy: targetLevels,
    updated_at: nowIso,
  }).eq("id", recommendationId);
  if (updErr) throw updErr;

  return { ok: true, accountId: reco.account_id, newLevels: targetLevels, kind: reco.kind };
}

/** Backwards-compatible name — the routes and the existing frontend hook call
 * this. Same behaviour, now with staleness and safety checks in front of it. */
async function acceptRecommendation(recommendationId, userId = null) {
  const result = await applyRecommendation(recommendationId, userId);
  // The original contract was "resolves on success, throws otherwise"; keep a
  // recognizable shape while surfacing the new conflict information.
  if (!result.ok) {
    const err = new Error(result.message || "Could not apply this recommendation.");
    err.code = result.code;
    err.conflict = Boolean(result.conflict);
    throw err;
  }
  return { alreadyAccepted: Boolean(result.alreadyApplied), accountId: result.accountId, newLevels: result.newLevels };
}

/** Reject — the COA is left completely unchanged; only the decision is stored. */
async function rejectRecommendation(recommendationId, userId = null, reason = null) {
  const trimmed = String(reason || "").trim() || null;
  const { error } = await supabase.from(TABLE).update({
    status: "rejected",
    rejection_reason: trimmed,
    decided_at: new Date().toISOString(),
    decided_by: userId,
    updated_at: new Date().toISOString(),
  })
    .eq("id", recommendationId)
    .in("status", ["pending"]);
  if (error) throw error;
  return { ok: true };
}

/** Backwards-compatible alias for the original route/hook. */
async function ignoreRecommendation(recommendationId, userId = null, reason = null) {
  return rejectRecommendation(recommendationId, userId, reason);
}

module.exports = {
  generateRecommendations,
  listRecommendations,
  applyRecommendation,
  acceptRecommendation,
  rejectRecommendation,
  ignoreRecommendation,
  // exported for unit testing — pure functions, no DB/network
  columnsToLevels,
  buildSectionCatalog,
  buildSiblingIndex,
  toReviewInput,
  buildReasonablenessPrompt,
  normalizeProposal,
  resolveSource,
  resolveImpact,
  isMaterial,
  resolveTargetLevels,
  validateTargetLevels,
  classificationFingerprint,
  toPublicRecommendation,
};
