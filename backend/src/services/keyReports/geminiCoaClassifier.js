// ============================================================================
// Chart of Accounts — Gemini deep-level refiner (Key Reports redesign)
//
// Takes the deduped list of accounts (each already placed into the STANDARDIZED
// levels 1–4 by coaHierarchyRules) and asks Gemini to:
//   (a) propose the deeper, company-specific category labels that sit BETWEEN
//       the standardized group (level 4) and the base account, and
//   (b) suggest a normalized display name for the account.
//
// This is strictly ADDITIVE and NON-FATAL: any failure (no API key, quota,
// malformed JSON, timeout) resolves to an empty refinement map, and the caller
// falls back to the rule-only classification. It never throws to the sync path.
//
// Reuses the Gemini client conventions from geminiFinancialParser.js (model
// fallback list, fixed-delay quota retry, code-fence-tolerant JSON parsing).
// ============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getGeminiModels } = require("../../config/geminiModels");

// Dynamically selected via GEMINI_MODELS / GEMINI_MODEL env; this array is the
// default fallback order used when no override is configured.
const GEMINI_MODELS = getGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cap how many accounts we send in one prompt; batch the rest. Keeps prompts
// well within token limits and bounds latency.
const BATCH_SIZE = 60;
// Classify call is smaller per-item output — allow slightly larger batches.
const CLASSIFY_BATCH_SIZE = 45;
// Hard cap on total accounts refined per generation — a runaway/cost guard.
const MAX_ACCOUNTS = 600;

// Valid 6-type model values returned by classifyAccountsWithAI.
const VALID_ACCOUNT_TYPES = new Set([
  'asset', 'liability', 'equity', 'income', 'cogs', 'expense',
]);

// Standard fixed-hierarchy labels that must NOT appear in deeperLevels (they are
// already placed by coaHierarchyRules.STANDARD_PREFIX before the base account).
const EXCLUDED_DEEPER_LABELS = new Set([
  'income statement', 'balance sheet', 'net income', 'pretax income',
  'operating income', 'gross profit', 'total revenue', 'total expenses',
  'total assets', 'total liabilities', 'total equity', 'expenses', 'income',
  'net loss', 'total liabilities and equity',
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
    const retryDelay = 3000;
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
        if (isQuota && retries > 1) {
          await sleep(retryDelay);
          retries -= 1;
        } else {
          break;
        }
      }
    }
  }
  throw new Error(`Gemini COA refinement failed: ${String(lastError?.message || "unknown error")}`);
}

function buildPrompt(batch) {
  // Each item: { key, accountName, accountNumber, standardizedPath }
  // standardizedPath is the COMPLETE already-classified hierarchy (all fixed levels).
  const lines = batch.map((a) => {
    const standardized = a.standardizedPath
      || [a.level1, a.level2, a.level3, a.level4].filter(Boolean).join(" > ");
    const num = a.accountNumber ? ` (#${a.accountNumber})` : "";
    return `- key="${a.key}" account="${a.accountName}"${num} fixed_hierarchy="${standardized}"`;
  });

  return `You are a financial chart-of-accounts expert for an ERP system.

For each account below, ALL fixed hierarchy levels are already set in fixed_hierarchy.
Your ONLY job is to suggest 0–3 concise company-specific sub-category labels that sit
BETWEEN the last fixed level and the base account itself.

Critical rules:
1. NEVER repeat or include any label already present in fixed_hierarchy.
2. NEVER include the account name itself in deeperLevels.
3. NEVER create arbitrary business names, location names, bank names, or
   operational groupings (e.g. "Operating Accounts", "Primary Business", "Provident Bank").
4. Only add a label if it meaningfully categorizes the account within a standard
   financial chart-of-accounts. When in doubt, return an empty array [].
5. Keep labels short and professional (e.g. "Employee Benefits", "Restaurant Revenue").
6. "normalizedName": clean, human-readable version of the account name.
   Fix casing, expand obvious abbreviations. Do NOT invent meaning.
7. Return STRICT JSON only — no markdown, no prose.

Output format:
{ "accounts": [ { "key": "<echo key>", "deeperLevels": ["..."], "normalizedName": "..." } ] }

Accounts:
${lines.join("\n")}`;
}

/**
 * Refine a list of accounts with Gemini.
 *
 * @param {Array<{key,accountName,accountNumber,level1,level2,level3,level4}>} accounts
 * @returns {Promise<Map<string,{deeperLevels:string[], normalizedName:string|null}>>}
 *   keyed by `key`. Empty map on any failure (caller falls back to rules).
 */
async function refineAccounts(accounts) {
  const out = new Map();
  if (!process.env.GEMINI_API_KEY) {
    console.log("[CoaClassifier] GEMINI_API_KEY not set — skipping AI refinement (rule-only).");
    return out;
  }
  const list = (accounts || []).slice(0, MAX_ACCOUNTS);
  if (!list.length) return out;

  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = list.slice(i, i + BATCH_SIZE);
    try {
      const text = await callGeminiText(buildPrompt(batch));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      for (const r of rows) {
        const key = String(r?.key || "").trim();
        if (!key) continue;
        const deeperLevels = Array.isArray(r.deeperLevels)
          ? r.deeperLevels.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6)
          : [];
        const normalizedName = r.normalizedName ? String(r.normalizedName).trim() : null;
        out.set(key, { deeperLevels, normalizedName });
      }
    } catch (err) {
      // Non-fatal: log and continue. Accounts in this batch keep rule-only paths.
      console.warn(`[CoaClassifier] batch ${i / BATCH_SIZE} refinement skipped: ${err.message}`);
    }
  }
  return out;
}

// ── AI-first account type classification ─────────────────────────────────────

function normalizeAccountType(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (t === 'asset' || t === 'assets') return 'asset';
  if (t === 'liability' || t === 'liabilities') return 'liability';
  if (t === 'equity') return 'equity';
  if (t === 'income' || t === 'revenue') return 'income';
  if (t === 'cogs' || t.startsWith('cost of goods') || t.startsWith('cost of sales') || t.startsWith('cost of')) return 'cogs';
  if (t === 'expense' || t === 'expenses') return 'expense';
  return '';
}

function buildClassifyPrompt(batch) {
  const lines = batch.map((a) => {
    const num = a.accountNumber ? ` [#${a.accountNumber}]` : '';
    const section = a.bsSection ? ` [BS section: ${a.bsSection}]` : '';
    const hint = a.rulesHint ? ` [keyword-rules suggest: ${a.rulesHint}]` : '';
    return `- key="${a.key}" name="${a.accountName}"${num}${section}${hint}`;
  });

  return `You are a Certified Public Accountant classifying General Ledger accounts for a chart of accounts system.

ACCOUNT TYPES — choose exactly one:
  asset       Cash, bank/checking/savings accounts, A/R, inventory, PP&E, vehicles owned, prepaid
  liability   A/P, loans payable, credit card accounts, accrued liabilities, deferred revenue
  equity      Owner equity/draws/distributions, retained earnings, contributed capital
  income      Sales, revenue, service fees, interest/rental income (credit-normal P&L)
  cogs        Cost of goods sold, direct materials, direct labor, direct costs
  expense     Operating expenses (debit-normal P&L): salaries, rent, insurance, utilities, repairs

OVERRIDES — these take precedence over keyword signals:
  • Bank/checking/savings ACCOUNT → asset   |  Bank FEE/CHARGE/SERVICE → expense
  • Credit card ACCOUNT (Visa, AMEX, MC, Discover) → liability  |  Card FEE/INTEREST → expense
  • Vehicle/fleet OWNERSHIP (motor vehicles, company trucks) → asset  |  Fuel, repairs, mileage → expense
  • Insurance premiums paid → expense  |  Insurance receivable/deposit → asset
  • Owner draws / distributions / dividends paid → equity
  • Prepaid X → asset  |  Accrued X → liability
  • X Receivable / Due From → asset  |  X Payable / Due To → liability
  • Loans TO others (you lend) → asset  |  Loans FROM others (you borrow) → liability

deeperLevels: 0–2 short sub-category labels for grouping. Omit unless genuinely useful.
  MUST NOT include any of: Income Statement, Balance Sheet, Net Income, Pretax Income,
    Operating Income, Gross Profit, Total Revenue, Total Expenses, Total Assets,
    Total Liabilities, Total Equity, Expenses, Income, Net Loss — the system already places these.
  Useful examples:
    checking/savings account  → ["Current Assets","Bank Accounts"]
    credit card account       → ["Current Liabilities","Credit Cards"]
    vehicle owned             → ["Fixed Assets","Vehicles"]
    equipment owned           → ["Fixed Assets","Machinery & Equipment"]
    insurance expense         → ["Insurance"]
    payroll / wages           → ["Payroll and Labor"]
    repairs / maintenance     → ["Repairs and Maintenance"]
    rent / utilities          → ["Occupancy"]
    typical sales revenue     → []
    owner equity account      → []

skip: true ONLY for calculated subtotal/total/section-header/metadata rows (not real accounts):
  skip=true examples: "Total Assets", "Net Income", "Gross Profit", "Total Expenses",
    "Assets", "Liabilities", "Equity", "Income", "Expenses", "Cost of Goods Sold",
    "Subtotal", "Less:", "Accrual Basis", "Cash Basis", "As of Dec 31 2024", "Report Date"

normalizedName: clean title-case display name — fix casing, expand common abbreviations,
  strip leading account-code prefixes already removed from the input. Do NOT invent meaning.

Return STRICT JSON — no markdown, no prose:
{"accounts":[{"key":"...","accountType":"...","confidence":0.0,"normalizedName":"...","deeperLevels":[],"skip":false}]}

Accounts to classify:
${lines.join('\n')}`;
}

/**
 * AI-first account type classification (primary classification step).
 *
 * Classifies unique GL account names into the 6-type model using Gemini, also
 * flags calculated/header rows as skip and returns deeper hierarchy hints and a
 * normalized display name.  coaAccountClassifier rules are the FALLBACK when AI
 * confidence is below threshold or this call fails.
 *
 * Always resolves — returns an empty Map on any failure so the rules-only path stands.
 *
 * @param {Array<{key, accountName, accountNumber, bsSection, rulesHint}>} accounts
 * @returns {Promise<Map<string, {accountType, confidence, normalizedName, deeperLevels, skip}>>}
 */
async function classifyAccountsWithAI(accounts) {
  const out = new Map();
  if (!process.env.GEMINI_API_KEY) {
    console.log('[CoaClassifier] GEMINI_API_KEY not set — AI classification skipped (rule-only fallback).');
    return out;
  }
  const list = (accounts || []).slice(0, MAX_ACCOUNTS);
  if (!list.length) return out;

  let failedBatches = 0;
  for (let i = 0; i < list.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = list.slice(i, i + CLASSIFY_BATCH_SIZE);
    try {
      const text = await callGeminiText(buildClassifyPrompt(batch));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      for (const r of rows) {
        const key = String(r?.key || '').trim();
        if (!key) continue;
        const skip = Boolean(r.skip);
        const rawType = normalizeAccountType(r.accountType);
        const accountType = VALID_ACCOUNT_TYPES.has(rawType) ? rawType : '';
        const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
        const normalizedName = r.normalizedName ? String(r.normalizedName).trim() : null;
        const deeperLevels = Array.isArray(r.deeperLevels)
          ? r.deeperLevels
              .map((x) => String(x || '').trim())
              .filter((x) => x && !EXCLUDED_DEEPER_LABELS.has(x.toLowerCase()))
              .slice(0, 3)
          : [];
        out.set(key, { accountType, confidence, normalizedName, deeperLevels, skip });
      }
    } catch (err) {
      failedBatches += 1;
      console.warn(
        `[CoaClassifier] classification batch ${Math.floor(i / CLASSIFY_BATCH_SIZE) + 1} failed: ${err.message}`,
      );
    }
  }

  const classified = [...out.values()].filter((v) => !v.skip && v.accountType).length;
  const skipped   = [...out.values()].filter((v) => v.skip).length;
  console.log(
    `[CoaClassifier] AI classification: ${list.length} accounts → ${classified} classified, ` +
    `${skipped} skip-flagged` +
    (failedBatches ? `, ${failedBatches} batch(es) failed (rules fallback for those accounts)` : ''),
  );
  return out;
}

module.exports = { refineAccounts, classifyAccountsWithAI };
