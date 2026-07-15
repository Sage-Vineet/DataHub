// ============================================================================
// Chart of Accounts — AI account recognition (Key Reports redesign)
//
// classifyAccountsWithAI(accounts)
//   Single batched Gemini call that recognizes every unique GL account and
//   returns ONLY:
//     • accountType    — 6-type model (asset | liability | equity | income | cogs | expense)
//     • normalizedName — clean display name
//     • confidence     — 0–1 score; below AI_NEEDS_REVIEW_THRESHOLD the account is
//                        flagged for manual review rather than forced into a type
//     • isReportRow    — true for calculated totals / headers (Total Assets,
//                        Net Income, etc.) — these must NOT be inserted into the COA
//
// Gemini performs account RECOGNITION ONLY. It does not return section,
// deeperLevels, hierarchy levels, hierarchy_path, or sort_order — hierarchy
// placement is looked up by coaMappingService directly against other
// chart_of_accounts rows (the only hierarchy table in the system), keyed on
// accountType + normalizedName/accountNumber (Account Number > Exact Name >
// Normalized Name > Fuzzy Match > Manual Review). No keyword / regex /
// hardcoded classification logic remains.
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

const GEMINI_MODELS = getGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Maximum accounts per Gemini prompt.  Keeps token usage bounded.
const CLASSIFY_BATCH_SIZE = 45;
// Hard cap — cost/runaway guard.
const MAX_ACCOUNTS = 600;

// ── Classification reuse cache ────────────────────────────────────────────────
// Confident AI classifications are cached per company by normalized account name
// so re-syncs only send NEW / low-confidence accounts to Gemini. Reuse reproduces
// the exact prior AI result (accuracy-neutral). Low-confidence and no-result
// accounts are intentionally NOT cached so they are re-attempted and continue to
// surface in Review & Adjust. Bump CLASSIFIER_CACHE_VERSION to invalidate all
// cached classifications after any change to the prompt or output handling.
const CLASSIFIER_CACHE_VERSION = "v3";
const CACHE_MIN_CONFIDENCE = 0.85;

function coaCacheEnabled() {
  return String(process.env.KEY_REPORT_COA_CACHE || "on").toLowerCase() !== "off";
}

function isCacheableClassification(v) {
  return Boolean(v && (v.isReportRow || (v.accountType && Number(v.confidence) >= CACHE_MIN_CONFIDENCE)));
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
 * @param {Array<{key, accountName, accountNumber, bsSection}>} batch
 */
function buildClassifyPrompt(batch) {
  const lines = batch.map((a) => {
    const num     = a.accountNumber ? ` [#${a.accountNumber}]`        : "";
    const section = a.bsSection     ? ` [BS section: ${a.bsSection}]` : "";
    return `- key="${a.key}" name="${a.accountName}"${num}${section}`;
  });

  return `You are a Certified Public Accountant (CPA) with deep knowledge of GAAP, IFRS, and every major ERP system (QuickBooks, Xero, Sage, NetSuite, Dynamics, SAP).

Recognize each General Ledger account below purely from its semantic meaning.
You are performing ACCOUNT RECOGNITION ONLY — do not think about where this
account sits in a reporting hierarchy; that is handled elsewhere.

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
Return STRICT JSON only — no markdown, no prose, no commentary:
{
  "accounts": [
    {
      "key": "<echo key exactly>",
      "isReportRow": false,
      "accountType": "<one of: asset|liability|equity|income|cogs|expense>",
      "normalizedName": "<clean display name>",
      "confidence": 0.95
    }
  ]
}

Accounts to classify:
${lines.join("\n")}`;
}

/**
 * AI-driven account type + hierarchy classification.
 *
 * Classifies unique GL account names into the 6-type model, detects report
 * rows (isReportRow), and provides a normalized display name and confidence
 * score. Account recognition only — no section, hierarchy levels, or
 * normal_balance; hierarchy placement is coaMappingService's job, and normal
 * balance is a fixed function of accountType (see chartOfAccountsService's
 * normalBalanceFor).
 *
 * Non-fatal: any failure returns an empty Map so the caller can mark affected
 * accounts as needsReview rather than applying incorrect hardcoded fallbacks.
 *
 * @param {Array<{key, accountName, accountNumber, bsSection}>} accounts
 *   key         — normName(rawAccountName); must match the key used in addLeaf
 *   accountName — normalizeForGemini(rawName) (leading account codes stripped)
 *   accountNumber — optional GL account number string
 *   bsSection   — optional BS section label (authoritative when present)
 * @returns {Promise<Map<string, {
 *   accountType: string,
 *   normalizedName: string|null,
 *   confidence: number,
 *   isReportRow: boolean
 * }>>}
 */
async function classifyAccountsWithAI(accounts, opts = {}) {
  const out = new Map();
  const companyId = opts.companyId || null;
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
      const text = await callGeminiText(buildClassifyPrompt(batch));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : [];

      for (const r of rows) {
        const key = String(r?.key || "").trim();
        if (!key) continue;

        const isReportRow = Boolean(r.isReportRow);
        if (isReportRow) {
          const value = { isReportRow: true, accountType: "", normalizedName: null, confidence: 1 };
          out.set(key, value);
          if (isCacheableClassification(value) && cacheableKeys.has(key)) toStore.push({ key, classification: value });
          continue;
        }

        const rawType    = normalizeAccountType(r.accountType);
        const accountType = VALID_ACCOUNT_TYPES.has(rawType) ? rawType : "";
        const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
        const normalizedName = r.normalizedName ? String(r.normalizedName).trim() : null;

        const value = { isReportRow: false, accountType, normalizedName, confidence };
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

// ── Rescue: re-type accounts wrongly flagged as report rows ───────────────────
// classifyAccountsWithAI sometimes marks a REAL posting account as isReportRow
// (e.g. "Augusta Rule"), which drops it from the COA entirely — so its GL
// activity never reaches the P&L / Balance Sheet and the reports stop
// reconciling to the General Ledger (Net Income off by that account's amount).
// This pass is called ONLY for accounts we KNOW are real (they have GL
// TRANSACTION rows). The prompt forbids isReportRow and forces a concrete type,
// so these accounts get classified and included instead of silently excluded.
function buildReclassifyPrompt(batch) {
  const lines = batch.map((a) => {
    const num = a.accountNumber ? ` [#${a.accountNumber}]` : "";
    return `- key="${a.key}" name="${a.accountName}"${num}`;
  });

  return `You are a Certified Public Accountant (CPA).

Every account listed below is a CONFIRMED REAL posting account — it has actual
General Ledger transactions. NONE of them are subtotals, section headers, or
report rows. You MUST classify each into exactly one of the six account types.

ACCOUNT TYPE — choose exactly one:
  asset       Cash, bank/checking/savings, A/R, inventory, PP&E, vehicles owned, prepaid, deposits
  liability   A/P, loans payable, credit card accounts, accrued liabilities, deferred revenue
  equity      Owner equity / draws / distributions, retained earnings, contributed capital
  income      Sales, revenue, service fees, interest/rental income; contra-revenue (refunds/discounts given)
  cogs        Cost of goods sold, direct materials, direct labor, direct costs
  expense     Operating expenses: salaries, rent, insurance, utilities, repairs, fees, tax strategies,
              and any deductible business expense that isn't COGS

RULES:
  • NEVER return isReportRow. Every account here is real — always return a concrete accountType.
  • If an account name is unusual or a strategy/program name (e.g. "Augusta Rule",
    "Accountable Plan"), classify by what it economically is — usually an operating expense.
  • Owner draws / distributions / dividends → equity. Retained earnings → equity.

Return STRICT JSON only — no markdown:
{
  "accounts": [
    { "key": "<echo key exactly>", "accountType": "<asset|liability|equity|income|cogs|expense>", "normalizedName": "<clean name>", "confidence": 0.90 }
  ]
}

Accounts:
${lines.join("\n")}`;
}

/**
 * Re-classify accounts that were wrongly flagged isReportRow but are known-real
 * (they have GL transaction activity). Returns Map<key, {isReportRow:false,
 * accountType, normalizedName, confidence}>. Non-fatal: empty Map on any failure.
 * Persists corrected classifications to the cache so later syncs skip the AI.
 */
async function reclassifyAsRealAccounts(accounts, opts = {}) {
  const out = new Map();
  const companyId = opts.companyId || null;
  const list = (accounts || []).slice(0, MAX_ACCOUNTS);
  if (!list.length || !process.env.GEMINI_API_KEY) return out;

  const toStore = [];
  for (let i = 0; i < list.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = list.slice(i, i + CLASSIFY_BATCH_SIZE);
    try {
      const text = await callGeminiText(buildReclassifyPrompt(batch));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      for (const r of rows) {
        const key = String(r?.key || "").trim();
        if (!key) continue;
        const accountType = normalizeAccountType(r.accountType);
        if (!VALID_ACCOUNT_TYPES.has(accountType)) continue;
        const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
        const normalizedName = r.normalizedName ? String(r.normalizedName).trim() : null;
        const value = { isReportRow: false, accountType, normalizedName, confidence };
        out.set(key, value);
        if (companyId) toStore.push({ key, classification: value });
      }
    } catch (err) {
      console.warn(`[CoaClassifier][reclassify] batch ${Math.floor(i / CLASSIFY_BATCH_SIZE) + 1} failed: ${err.message}`);
    }
  }
  // Overwrite the stale isReportRow cache entry with the corrected classification.
  await writeClassificationCache(companyId, toStore);
  console.log(`[CoaClassifier][reclassify] ${list.length} account(s) flagged as report rows but having GL activity → ${out.size} re-typed as real posting accounts.`);
  return out;
}

module.exports = { classifyAccountsWithAI, reclassifyAsRealAccounts, callGeminiText, parseJsonFromText };
