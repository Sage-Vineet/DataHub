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
// Hard cap on total accounts refined per generation — a runaway/cost guard.
const MAX_ACCOUNTS = 600;

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

module.exports = { refineAccounts };
