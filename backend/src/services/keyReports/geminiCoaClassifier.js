// ============================================================================
// Chart of Accounts — AI classification for accounts the uploaded COA doesn't cover
//
// classifyAccountsWithAI(accounts)
//   Single batched Gemini call — but ONLY for accounts chartOfAccountsService
//   already tried and failed to match against the company's own uploaded
//   Chart of Accounts (coaMappingService / coaAccountMatcher.js's 5-stage
//   deterministic engine runs FIRST; this is the fallback, not the primary
//   source). Returns:
//     • accountType    — 6-type model (asset | liability | equity | income | cogs | expense)
//     • normalizedName — clean display name
//     • confidence     — 0–1 score; below AI_NEEDS_REVIEW_THRESHOLD the account is
//                        flagged for manual review rather than forced into a type
//     • isReportRow    — true for calculated totals / headers (Total Assets,
//                        Net Income, etc.) — these must NOT be inserted into the COA
//     • levels         — the account's FULL level_1..level_15 roll-up hierarchy,
//                        reasoned out like a CPA building a chart of accounts
//     • reasoning      — 1-2 sentence justification for the hierarchy chosen
//
// An account arrives here for exactly one of two reasons (see
// chartOfAccountsService.generateChartOfAccounts/ensureCoaComplete):
//   1. It genuinely doesn't exist in the uploaded COA — Gemini reasons a
//      fresh hierarchy from this company's own Balance Sheet/P&L section
//      evidence and account name, never from another company's data.
//   2. It matched MORE THAN ONE row in the uploaded COA and structural
//      evidence (parent/type/level) couldn't disambiguate — the account
//      carries an `ambiguousCandidates` list; Gemini picks the best-fitting
//      one (reusing its hierarchy verbatim) or reasons fresh if none fit.
// To keep siblings (e.g. multiple bank accounts newly discovered together)
// converging on the same shared branch instead of drifting batch to batch,
// each prompt is also given this company/version's own already-established
// category paths (loadKnownCategoryPaths) and instructed to reuse them
// verbatim whenever an account genuinely belongs there.
//
// This function is NON-FATAL: any failure (no API key, quota, malformed JSON,
// timeout) resolves to an empty Map, and the caller marks affected accounts
// as needsReview rather than applying a fallback classification.
//
// Reuses Gemini client conventions from geminiFinancialParser.js.
// ============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getGeminiModels } = require("../../config/geminiModels");
const { supabase } = require("../../db");

const GEMINI_MODELS = getGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Maximum accounts per Gemini prompt. Smaller than the old type-only batch
// (45) because each account's output now includes a full 15-level hierarchy
// array plus reasoning — roughly 4x the output per account — and token usage
// must stay bounded.
const CLASSIFY_BATCH_SIZE = 18;
// Hard cap — cost/runaway guard.
const MAX_ACCOUNTS = 600;
// Hierarchy arrays are always this long (nulls pad unused deeper levels).
const MAX_LEVELS = 15;

// ── Classification reuse cache ────────────────────────────────────────────────
// Confident AI classifications are cached per company by normalized account name
// so re-syncs only send NEW / low-confidence accounts to Gemini. Reuse reproduces
// the exact prior AI result (accuracy-neutral). Low-confidence and no-result
// accounts are intentionally NOT cached so they are re-attempted and continue to
// surface in Review & Adjust. Bump CLASSIFIER_CACHE_VERSION to invalidate all
// cached classifications after any change to the prompt or output handling.
// v5: cached shape grew from {isReportRow,accountType,normalizedName,confidence}
// to also include {levels, reasoning} (full hierarchy generation) — every v4
// entry is stale under the new shape and must be re-classified once.
const CLASSIFIER_CACHE_VERSION = "v5";
const CACHE_MIN_CONFIDENCE = 0.85;

function coaCacheEnabled() {
  return String(process.env.KEY_REPORT_COA_CACHE || "on").toLowerCase() !== "off";
}

function isCacheableClassification(v) {
  if (!v) return false;
  if (v.isReportRow) return true;
  return Boolean(v.accountType && Number(v.confidence) >= CACHE_MIN_CONFIDENCE && Array.isArray(v.levels) && v.levels.some(Boolean));
}

// Fill `out` with any cached classifications for the given accounts and return
// the subset of accounts that still need AI classification. Company-scoped;
// degrades to "classify everything" if disabled, no companyId, or table absent.
async function primeFromClassificationCache(companyId, list, out) {
  if (!coaCacheEnabled() || !companyId) return list;
  try {
    // Only accounts WITHOUT a bsSection are cache-eligible. When a bsSection is
    // present the prompt treats it as authoritative, so a name-only cached result
    // could be wrong for that context — those are always classified fresh.
    const keys = [...new Set(list.filter((a) => !a.bsSection).map((a) => a.key).filter(Boolean))];
    if (!keys.length) return list;

    const cached = new Map();
    const CHUNK = 200;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("key_report_coa_classification_cache")
        .select("normalized_name, classification")
        .eq("company_id", companyId)
        .eq("classifier_version", CLASSIFIER_CACHE_VERSION)
        .in("normalized_name", keys.slice(i, i + CHUNK));
      if (error) return list; // table missing / error → no cache
      for (const row of data || []) {
        if (row?.normalized_name && row.classification) cached.set(row.normalized_name, row.classification);
      }
    }
    if (!cached.size) return list;

    const misses = [];
    for (const a of list) {
      const hit = !a.bsSection ? cached.get(a.key) : null;
      if (hit) out.set(a.key, hit);
      else misses.push(a);
    }
    return misses;
  } catch {
    return list; // graceful — never block classification on a cache error
  }
}

async function writeClassificationCache(companyId, entries) {
  if (!coaCacheEnabled() || !companyId || !entries.length) return;
  try {
    const now = new Date().toISOString();
    const rows = entries.map((e) => ({
      company_id: companyId,
      normalized_name: e.key,
      classifier_version: CLASSIFIER_CACHE_VERSION,
      classification: e.classification,
      updated_at: now,
    }));
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await supabase
        .from("key_report_coa_classification_cache")
        .upsert(rows.slice(i, i + CHUNK), { onConflict: "company_id,normalized_name,classifier_version" });
    }
  } catch {
    // Non-fatal — caching is an optimization, never a correctness dependency.
  }
}

// Valid 6-type accountType values.
const VALID_ACCOUNT_TYPES = new Set([
  "asset", "liability", "equity", "income", "cogs", "expense",
]);

function parseJsonFromText(text = "") {
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

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
        return result.response.text();
      } catch (err) {
        lastError = err;
        const msg = String(err?.message || err);
        const isQuota = msg.includes("429") || msg.toLowerCase().includes("quota");
        const isNotFound = msg.includes("404") || msg.toLowerCase().includes("not found");
        console.warn(`[CoaClassifier] Model ${modelName} failed: ${msg}`);
        if (isNotFound) break;
        if (isQuota && retries > 1) { await sleep(3000); retries -= 1; } else break;
      }
    }
  }
  throw new Error(`Gemini COA classification failed: ${String(lastError?.message || "unknown")}`);
}

function normalizeAccountType(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (t === "asset" || t === "assets") return "asset";
  if (t === "liability" || t === "liabilities") return "liability";
  if (t === "equity") return "equity";
  if (t === "income" || t === "revenue") return "income";
  if (t === "cogs" || t.startsWith("cost of goods") || t.startsWith("cost of sales") || t.startsWith("cost of")) return "cogs";
  if (t === "expense" || t === "expenses") return "expense";
  return "";
}

/**
 * Build the Gemini prompt for a batch of accounts.
 *
 * @param {Array<{key, accountName, accountNumber, bsSection, plSection, bsSubSection, ambiguousCandidates}>} batch
 * @param {string[]} [knownPaths] — this company/version's own already-established
 *   category paths (chartOfAccountsService.loadKnownCategoryPaths), " > "-joined
 *   top-to-leaf-parent strings. Given so siblings converge on the same branch
 *   across batches instead of drifting; never another company's data.
 */
function buildClassifyPrompt(batch, knownPaths = []) {
  const lines = batch.map((a) => {
    const num       = a.accountNumber ? ` [#${a.accountNumber}]`          : "";
    const bsSec     = a.bsSection     ? ` [BS section: ${a.bsSection}]`   : "";
    const bsSub     = a.bsSubSection  ? ` [BS sub-section: ${a.bsSubSection}]` : "";
    const plSec     = a.plSection     ? ` [P&L section: ${a.plSection}]` : "";
    const candidates = a.ambiguousCandidates?.length
      ? ` [UPLOADED COA CANDIDATES — this account matched more than one row in the company's own\n    uploaded Chart of Accounts and structural evidence couldn't tell them apart; pick the one\n    whose hierarchy genuinely fits this account and reuse ITS hierarchy verbatim as your\n    "levels" answer, or ignore all of them and reason a fresh hierarchy if none genuinely fit:\n${a.ambiguousCandidates.map((c, i) => `      ${i + 1}. "${c.accountName}" -> ${c.hierarchyPath}`).join("\n")}]`
      : "";
    return `- key="${a.key}" name="${a.accountName}"${num}${bsSec}${bsSub}${plSec}${candidates}`;
  });

  const knownPathsBlock = knownPaths.length
    ? `\n──────────────────────────────────────────────────────────────────────────────\nALREADY-ESTABLISHED CATEGORY PATHS for THIS company (reuse verbatim whenever an\naccount below genuinely belongs under one of these — never paraphrase, reorder,\nor invent a near-duplicate of one of these; only branch a genuinely new path\nwhen nothing here fits):\n${knownPaths.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n`
    : "";

  return `You are a Certified Public Accountant (CPA) with deep knowledge of GAAP, IFRS, and every major ERP system (QuickBooks, Xero, Sage, NetSuite, Dynamics, SAP).

For each General Ledger account below, do TWO things: (1) recognize its
account type from semantic meaning, and (2) build its full reporting
hierarchy — the chain of increasingly broader parents a real accountant
would use, from the most general roll-up down to this account's own leaf
position — derived from this company's OWN Balance Sheet / P&L section
evidence and account name, never from another company's chart of accounts,
a generic template, or a hardcoded list.

Every account below already failed to match cleanly against this company's
own uploaded Chart of Accounts (or matched more than one row ambiguously) —
that's exactly why you're being asked. Some accounts carry an "UPLOADED COA
CANDIDATES" note: pick the best-fitting one and reuse its hierarchy verbatim,
or reason a fresh one if truly none fit — see that note for the exact rule.

──────────────────────────────────────────────────────────────────────────────
ACCOUNT TYPE — choose exactly one of these six values:
  asset       Cash, bank/checking/savings, A/R, inventory, PP&E, vehicles owned, prepaid, deposits
  liability   A/P, loans payable, credit card accounts, accrued liabilities, deferred revenue
  equity      Owner equity / draws / distributions, retained earnings, contributed capital
  income      Sales, revenue, service fees, interest/rental income (credit-normal P&L),
              plus contra-revenue: refunds/discounts/returns GIVEN to customers
  cogs        Cost of goods sold, direct materials, direct labor, direct costs
  expense     Operating expenses (debit-normal P&L): salaries, rent, insurance, utilities, repairs

CRITICAL ACCOUNTING RULES:
  • Bank/checking/savings ACCOUNT → asset
  • Bank FEE / CHARGE / SERVICE   → expense
  • Credit card ACCOUNT (Visa, AMEX, MC, Discover, store card) → liability
  • Credit card BILL / credit card bill account / credit card payment → expense (do NOT classify as liability)
  • Credit card FEE / INTEREST    → expense
  • Vehicle/fleet OWNERSHIP (motor vehicles, company trucks, fleet) → asset
  • Fuel, repairs, mileage, car & truck expenses → expense
  • Insurance PREMIUMS PAID → expense
  • Insurance RECEIVABLE / DEPOSIT → asset
  • Owner draws / distributions / dividends paid → equity
  • Prepaid X → asset
  • Accrued X → liability
  • X Receivable / Due From → asset
  • X Payable / Due To → liability
  • Loans TO others (you are the lender) → asset
  • Loans FROM others (you are the borrower) → liability
  • Accumulated Depreciation → asset (contra-asset)
  • Goodwill, intangibles, deposits, notes receivable, Other Long-term Assets → asset
  • Refunds / Discounts / Returns / Allowances GIVEN to customers (e.g. "Refunds to Customers",
    "Discounts/Refunds Given", "Sales Returns and Allowances") → income
    (contra-revenue: it reduces total revenue, it is NOT an operating expense, even though
    money is flowing out — classify by what it nets against, not by cash direction)
  • If [BS section] is provided it is authoritative — use it to confirm the correct accountType

REASONING PRINCIPLES — apply these when a name doesn't match a rule above verbatim.
Do not pattern-match on a single leading word in isolation; read the whole compound name.
  • Asset word + operational/consumable word = expense, not asset. The cost of USING,
    fueling, servicing, repairing, or renting an asset is an expense even though the asset
    itself is a name component (e.g. an asset-category noun followed by "Fuel", "Repairs",
    "Maintenance", "Rental", "Supplies" for a specific job/vehicle/site describes ongoing
    consumption, not something owned). Classify by what is being consumed or paid for, not
    by the asset word alone. Only classify as asset when the name refers to ACQUIRING or
    OWNING the item itself, not to the cost of operating it.
  • "Supplies" is context-dependent: supplies consumed for a specific job, project, vehicle,
    or site are an expense (they get used up and posted to the P&L); supplies held in a
    general inventory/stockroom awaiting future use or resale are an asset. Read the full
    phrase to tell which one applies.
  • A recognizable financial institution, bank, or card-network name in an account title
    (a lender, credit card issuer, or bank the company holds an account or debt with) always
    signals a real-world financial account — a liability if it represents a card or loan
    balance owed, or an asset if it represents a deposit/checking account held there. Judge
    by economic substance (what the account represents), never by superficial overlap
    between part of an institution's name and unrelated accounting terminology (e.g. a
    brand name that happens to contain a word like "capital" is not automatically equity —
    equity requires the account to represent the OWNER'S stake in the business, not a
    third-party institution's brand).
  • When genuinely torn between two of the six types for a compound or unfamiliar name,
    prefer the interpretation that matches how the cost/value flows through the business
    (consumed → expense; owned → asset; owed → liability; owner's stake → equity) over a
    surface-level word match, and lower your confidence accordingly rather than guessing.

IS REPORT ROW — set isReportRow: true ONLY for calculated totals, subtotals, or section headers
that are not real accounts. These must NEVER be inserted into the Chart of Accounts.
  isReportRow=true examples:
    "Total Assets", "Total Liabilities", "Total Equity", "Net Income", "Net Loss",
    "Gross Profit", "Operating Income", "Total Revenue", "Total Expenses",
    "Pretax Income", "Income Before Taxes", "Total Liabilities and Equity",
    "Assets", "Liabilities", "Equity", "Income", "Expenses", "Revenue",
    "Current Assets", "Fixed Assets", "Current Liabilities", "Long-Term Liabilities",
    "Subtotal", "Less:", "Cost of Goods Sold" (when it appears as a section header),
    date lines ("As of Dec 31 2024"), metadata ("Accrual Basis", "Cash Basis"),
    any line that is clearly a report subtotal and not a posting account

NORMALIZED NAME — clean title-case version of the account name.
  Strip leading numeric codes (e.g. "1000 - " or "10200 "). Fix casing.
  Expand obvious abbreviations. Do NOT invent meaning.

CONFIDENCE — 0.00 to 1.00.  Reflect genuine uncertainty; do not default to 0.99 for everything.
  High (≥ 0.90): unambiguous account (e.g. "Checking Account", "Accounts Receivable")
  Medium (0.70–0.89): common account with minor ambiguity
  Low (< 0.70): genuinely ambiguous; reviewable by a human accountant

──────────────────────────────────────────────────────────────────────────────
HIERARCHY — build the account's full roll-up path as an array of level strings,
level 1 = broadest (e.g. "Total Assets" / "Total Liabilities and Equity" /
"Total Income" / "Total Cost of Goods Sold" / "Total Expenses"), each
subsequent level strictly more specific than the one before it, ending at
this account's own immediate parent (do NOT include the account's own name
as a level — that is appended separately).

Think top-to-bottom like a real accountant building a reporting structure:
  • Determine the financial statement (Balance Sheet or P&L) from accountType.
  • Determine the reporting SECTION from real evidence — the [BS section] /
    [BS sub-section] / [P&L section] tags on the account below when present
    (e.g. Current Assets, Fixed Assets, Current Liabilities, Long-Term
    Liabilities, Cost of Goods Sold, Operating Expenses, Other Income, Other
    Expense) — these tags come directly from THIS company's own uploaded
    documents and are authoritative; never invent a section that isn't
    supported by the tag or by the account's own unambiguous meaning (e.g. an
    obvious "Income Tax Payable" implies a Current Tax grouping even with no
    tag; do not force a section when there is truly no evidence for one).
  • Add increasingly specific parents only when you have real grounds for
    them (e.g. "Cash and Cash Equivalents" above several bank/petty-cash
    accounts; "Credit Cards" above several card-issuer accounts; "Current Tax
    Payable" / "Deferred Tax Liability" as their own grouping when the account
    is clearly a tax line; "Other Income" / "Non-Operating Income or Expense" /
    "Other Comprehensive Income" as their own grouping when the account is
    clearly one of those, not ordinary operating income/expense).
  • Two accounts that are genuinely the same KIND of thing (e.g. two different
    banks' checking accounts, two different credit card issuers) MUST receive
    the IDENTICAL levels array up to the point their own names diverge — reuse
    an already-established path from the list below rather than building a
    slightly different one.
  • Never place a Balance Sheet account (asset/liability/equity) under a P&L
    root, or a P&L account (income/cogs/expense) under a Balance Sheet root.
  • Never invent a level with no real accounting meaning just to fill space.
    If the company's structure only naturally supports 3-4 real levels for an
    account, return only those 3-4 — do not pad with placeholders.
${knownPathsBlock}
──────────────────────────────────────────────────────────────────────────────
Return STRICT JSON only — no markdown, no prose, no commentary:
{
  "accounts": [
    {
      "key": "<echo key exactly>",
      "isReportRow": false,
      "accountType": "<one of: asset|liability|equity|income|cogs|expense>",
      "normalizedName": "<clean display name>",
      "confidence": 0.95,
      "levels": ["Total Assets", "Current Assets", "Cash and Cash Equivalents"],
      "reasoning": "<1-2 sentences: why this type and this hierarchy>"
    }
  ]
}

Accounts to classify:
${lines.join("\n")}`;
}

// Sanitize the AI's raw `levels` array: trimmed non-empty strings only, never
// includes the account's own name (that's appended by the caller), capped to
// leave room for it.
function sanitizeLevels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (l == null ? "" : String(l).trim()))
    .filter(Boolean)
    .slice(0, MAX_LEVELS - 1);
}

/**
 * AI-driven account type + full hierarchy generation.
 *
 * Classifies unique GL account names into the 6-type model, detects report
 * rows (isReportRow), and generates each account's full level_1..level_15
 * roll-up hierarchy directly from this company's own Balance Sheet/P&L
 * section evidence and account name — reasoned like a CPA, not looked up
 * from a fixed table or another company's chart of accounts. Normal balance
 * remains a fixed function of accountType (see chartOfAccountsService's
 * normalBalanceFor) and is not returned here.
 *
 * Non-fatal: any failure returns an empty Map so the caller can mark affected
 * accounts as needsReview rather than applying incorrect hardcoded fallbacks.
 *
 * @param {Array<{key, accountName, accountNumber, bsSection, plSection, bsSubSection, ambiguousCandidates}>} accounts
 *   key         — normName(rawAccountName); must match the key used in addLeaf
 *   accountName — normalizeForGemini(rawName) (leading account codes stripped)
 *   accountNumber — optional GL account number string
 *   bsSection   — optional BS section label (authoritative when present)
 *   plSection   — optional P&L section label
 *   bsSubSection — optional BS sub-section (current/fixed/long_term/other)
 * @param {{companyId?: string, categoryPaths?: string[]}} [opts]
 *   categoryPaths — this company/version's own already-established category
 *   path strings (chartOfAccountsService.loadKnownCategoryPaths(...).map(c => c.path)),
 *   given as context so siblings reuse the same branch instead of drifting.
 * @returns {Promise<Map<string, {
 *   accountType: string,
 *   normalizedName: string|null,
 *   confidence: number,
 *   isReportRow: boolean,
 *   levels: string[],
 *   reasoning: string|null
 * }>>}
 */
async function classifyAccountsWithAI(accounts, opts = {}) {
  const out = new Map();
  const companyId = opts.companyId || null;
  const categoryPaths = Array.isArray(opts.categoryPaths) ? opts.categoryPaths : [];
  const list = (accounts || []).slice(0, MAX_ACCOUNTS);
  if (!list.length) return out;

  // 1. Reuse confident classifications already cached for this company. Only the
  //    remaining (new / previously low-confidence) accounts go to the AI.
  const remaining = await primeFromClassificationCache(companyId, list, out);
  const reusedCount = out.size;

  if (!process.env.GEMINI_API_KEY) {
    console.log(
      reusedCount
        ? `[CoaClassifier] GEMINI_API_KEY not set — reused ${reusedCount} cached classification(s); ${remaining.length} account(s) flagged for review.`
        : "[CoaClassifier] GEMINI_API_KEY not set — AI classification skipped (accounts flagged for review).",
    );
    return out;
  }

  if (!remaining.length) {
    console.log(`[CoaClassifier] ${list.length} accounts → all ${reusedCount} served from classification cache (0 AI calls).`);
    return out;
  }

  // Only cache accounts that were classified WITHOUT a bsSection (see prime()).
  const cacheableKeys = new Set(remaining.filter((a) => !a.bsSection).map((a) => a.key));

  const toStore = [];
  let failedBatches = 0;
  for (let i = 0; i < remaining.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = remaining.slice(i, i + CLASSIFY_BATCH_SIZE);
    try {
      const text = await callGeminiText(buildClassifyPrompt(batch, categoryPaths));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : [];

      for (const r of rows) {
        const key = String(r?.key || "").trim();
        if (!key) continue;

        const isReportRow = Boolean(r.isReportRow);
        if (isReportRow) {
          const value = { isReportRow: true, accountType: "", normalizedName: null, confidence: 1, levels: [], reasoning: null };
          out.set(key, value);
          if (isCacheableClassification(value) && cacheableKeys.has(key)) toStore.push({ key, classification: value });
          continue;
        }

        const rawType    = normalizeAccountType(r.accountType);
        const accountType = VALID_ACCOUNT_TYPES.has(rawType) ? rawType : "";
        const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
        const normalizedName = r.normalizedName ? String(r.normalizedName).trim() : null;
        const levels = sanitizeLevels(r.levels);
        const reasoning = r.reasoning ? String(r.reasoning).trim().slice(0, 500) : null;

        const value = { isReportRow: false, accountType, normalizedName, confidence, levels, reasoning };
        out.set(key, value);
        if (isCacheableClassification(value) && cacheableKeys.has(key)) toStore.push({ key, classification: value });
      }
    } catch (err) {
      failedBatches += 1;
      console.warn(`[CoaClassifier] batch ${Math.floor(i / CLASSIFY_BATCH_SIZE) + 1} failed: ${err.message}`);
    }
  }

  // Persist newly-classified confident results for reuse on the next sync.
  await writeClassificationCache(companyId, toStore);

  const classified   = [...out.values()].filter((v) => !v.isReportRow && v.accountType).length;
  const reportRows   = [...out.values()].filter((v) => v.isReportRow).length;
  const noResult     = list.length - out.size;
  console.log(
    `[CoaClassifier] ${list.length} accounts → ${classified} classified ` +
    `(${reusedCount} reused from cache, ${remaining.length} sent to AI), ` +
    `${reportRows} report rows excluded` +
    (noResult     ? `, ${noResult} received no AI result (will be flagged for review)` : "") +
    (failedBatches ? `, ${failedBatches} batch(es) failed`                             : ""),
  );
  return out;
}

module.exports = { classifyAccountsWithAI, callGeminiText, parseJsonFromText };
