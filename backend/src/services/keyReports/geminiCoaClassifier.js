// ============================================================================
// Chart of Accounts — AI classification engine (Key Reports redesign)
//
// classifyAccountsWithAI(accounts)
//   Single batched Gemini call that classifies every unique GL account into:
//     • accountType  — 6-type model (asset | liability | equity | income | cogs | expense)
//     • section      — accounting section within the financial statement
//                      (e.g. "Current Assets", "Operating Expenses")
//     • deeperLevels — 0–2 company-specific sub-category labels below section
//     • normalBalance — "debit" or "credit"
//     • normalizedName — clean display name
//     • confidence   — 0–1 score; below AI_NEEDS_REVIEW_THRESHOLD the account is
//                      flagged for manual review rather than forced into a type
//     • isReportRow  — true for calculated totals / headers (Total Assets,
//                      Net Income, etc.) — these must NOT be inserted into the COA
//
// All keyword / regex / hardcoded classification logic has been removed.
// The AI is solely responsible for all accounting decisions.
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
const CLASSIFIER_CACHE_VERSION = "v2";
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

// The exact section strings the AI is instructed to return.
// Must stay in sync with SECTION_STANDARD_LEVELS in coaHierarchyRules.js.
const VALID_SECTIONS = new Set([
  "Current Assets", "Fixed Assets", "Other Assets",
  "Current Liabilities", "Long-Term Liabilities", "Equity",
  "Revenue", "Cost of Goods Sold", "Operating Expenses",
  "Other Income", "Other Expense",
]);

// Valid 6-type accountType values.
const VALID_ACCOUNT_TYPES = new Set([
  "asset", "liability", "equity", "income", "cogs", "expense",
]);

// Standard hierarchy labels that the AI must NOT echo into deeperLevels.
// They are already placed by aiSectionToStandardLevels before the base account.
const EXCLUDED_DEEPER_LABELS = new Set([
  "income statement", "balance sheet",
  "net income", "pretax income", "operating income",
  "gross profit", "total revenue", "total expenses",
  "total assets", "total liabilities", "total equity",
  "income", "expenses",
  "net loss", "total liabilities and equity",
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

Classify each General Ledger account below purely from its semantic meaning.

──────────────────────────────────────────────────────────────────────────────
ACCOUNT TYPE — choose exactly one of these six values:
  asset       Cash, bank/checking/savings, A/R, inventory, PP&E, vehicles owned, prepaid, deposits
  liability   A/P, loans payable, credit card accounts, accrued liabilities, deferred revenue
  equity      Owner equity / draws / distributions, retained earnings, contributed capital
  income      Sales, revenue, service fees, interest/rental income (credit-normal P&L),
              plus contra-revenue: refunds/discounts/returns GIVEN to customers
  cogs        Cost of goods sold, direct materials, direct labor, direct costs
  expense     Operating expenses (debit-normal P&L): salaries, rent, insurance, utilities, repairs

SECTION — choose exactly one of these values (must match the accountType):
  For asset:     "Current Assets"  |  "Fixed Assets"  |  "Other Assets"
  For liability: "Current Liabilities"  |  "Long-Term Liabilities"
  For equity:    "Equity"
  For income:    "Revenue"  |  "Other Income"
  For cogs:      "Cost of Goods Sold"
  For expense:   "Operating Expenses"  |  "Other Expense"

CRITICAL ACCOUNTING RULES:
  • Bank/checking/savings ACCOUNT → asset, "Current Assets"
  • Bank FEE / CHARGE / SERVICE   → expense, "Operating Expenses"
  • Credit card ACCOUNT (Visa, AMEX, MC, Discover, store card) → liability, "Current Liabilities"
  • Credit card BILL / credit card bill account / credit card payment → expense, "Operating Expenses" (do NOT classify as liability)
  • Credit card FEE / INTEREST    → expense, "Operating Expenses"
  • Vehicle/fleet OWNERSHIP (motor vehicles, company trucks, fleet) → asset, "Fixed Assets"
  • Fuel, repairs, mileage, car & truck expenses → expense, "Operating Expenses"
  • Insurance PREMIUMS PAID → expense, "Operating Expenses"
  • Insurance RECEIVABLE / DEPOSIT → asset, "Current Assets"
  • Owner draws / distributions / dividends paid → equity, "Equity"
  • Prepaid X → asset, "Current Assets"
  • Accrued X → liability, "Current Liabilities"
  • X Receivable / Due From → asset
  • X Payable / Due To → liability
  • Loans TO others (you are the lender) → asset
  • Loans FROM others (you are the borrower) → liability
  • Long-term loans / mortgages with "long-term" signal → liability, "Long-Term Liabilities"
  • SBA / EIDL / PPP loans → liability, "Long-Term Liabilities"
  • Accumulated Depreciation → asset, "Fixed Assets"  (contra-asset)
  • Goodwill, intangibles, deposits, notes receivable, Other Long-term Assets (or Other Long Term Assets) → asset, "Other Assets"
  • Refunds / Discounts / Returns / Allowances GIVEN to customers (e.g. "Refunds to Customers",
    "Discounts/Refunds Given", "Sales Returns and Allowances") → income, "Revenue"
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

DEEPER LEVELS — 0 to 2 short sub-category labels that sit between the section and the
base account in the hierarchy.  Return [] when none are needed.
  Do NOT include any of: Income Statement, Balance Sheet, Net Income, Pretax Income,
    Operating Income, Gross Profit, Total Revenue, Total Expenses, Total Assets,
    Total Liabilities, Total Equity, Expenses, Income, Net Loss.
  Useful examples by type:
    checking / savings account    → ["Bank Accounts"]
    credit card account           → ["Credit Cards"]
    vehicle owned                 → ["Vehicles"]
    equipment owned               → ["Machinery & Equipment"]
    accounts receivable           → ["Accounts Receivable"]
    inventory                     → ["Inventory"]
    prepaid expenses              → ["Prepaid Expenses"]
    accounts payable              → ["Accounts Payable"]
    payroll / wages               → ["Payroll and Labor"]
    insurance expense             → ["Insurance"]
    repairs / maintenance         → ["Repairs and Maintenance"]
    rent / utilities              → ["Occupancy"]
    officer/owner loans payable   → ["Long-Term Loans"]
    generic sales revenue         → []
    owner equity account          → []

NORMAL BALANCE:
  debit  → asset, expense, cogs
  credit → liability, equity, income

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
      "section": "<one of the section values above>",
      "deeperLevels": [],
      "normalBalance": "<debit|credit>",
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
 * rows (isReportRow), returns the accounting section and deeper hierarchy
 * hints, and provides a normalized display name and confidence score.
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
 *   section: string,
 *   deeperLevels: string[],
 *   normalBalance: string,
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
          const value = { isReportRow: true, accountType: "", section: "", deeperLevels: [], normalBalance: "", normalizedName: null, confidence: 1 };
          out.set(key, value);
          if (isCacheableClassification(value) && cacheableKeys.has(key)) toStore.push({ key, classification: value });
          continue;
        }

        const rawType    = normalizeAccountType(r.accountType);
        const accountType = VALID_ACCOUNT_TYPES.has(rawType) ? rawType : "";
        const section    = VALID_SECTIONS.has(String(r.section || "")) ? String(r.section) : "";
        const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
        const normalizedName = r.normalizedName ? String(r.normalizedName).trim() : null;
        const normalBalance  = String(r.normalBalance || "").toLowerCase() === "credit" ? "credit" : "debit";

        const deeperLevels = Array.isArray(r.deeperLevels)
          ? r.deeperLevels
              .map((x) => String(x || "").trim())
              .filter((x) => x && !EXCLUDED_DEEPER_LABELS.has(x.toLowerCase()))
              .slice(0, 3)
          : [];

        const value = { isReportRow: false, accountType, section, deeperLevels, normalBalance, normalizedName, confidence };
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

module.exports = { classifyAccountsWithAI };
