// ============================================================================
// COA Category Selector — scalable cross-company hierarchy reuse
//
// Closes the one gap plain name-matching can never close on its own: a
// brand-new posting account (a different bank's credit card, a different
// vendor, a new utility provider) that shares no words with anything already
// mapped, but is clearly the same KIND of account as something that already
// has an approved place in the Chart of Accounts. "Visa Credit Card" and
// "AMEX" share zero characters — no fuzzy-matching algorithm can conclude
// they're the same category from the text alone; recognizing that requires
// understanding what a credit card IS, which is what this call is for.
//
// This is NOT hierarchy generation and it NEVER invents a category. It is
// given a CLOSED list of category paths that already exist somewhere in
// chart_of_accounts (built from real, previously matched/approved accounts —
// see chartOfAccountsService.loadKnownCategoryPaths) and picks the single
// best fit, or says none fit. Any answer not verbatim on that list, or below
// the confidence floor, is discarded — the account falls through to
// needs_mapping exactly as if this call had never run. Runs only as a
// second-line fallback, after coaMappingService's copy-only name/number
// matching has already failed to find anything.
// ============================================================================

"use strict";

const { callGeminiText, parseJsonFromText } = require("./geminiCoaClassifier");

const SELECT_BATCH_SIZE = 40;
const MIN_CATEGORY_CONFIDENCE = 0.80;

function buildSelectPrompt(batch, categoryPaths) {
  const catList = categoryPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const acctLines = batch
    .map((a) => `- key="${a.key}" name="${a.accountName}"${a.accountType ? ` type="${a.accountType}"` : ""}`)
    .join("\n");

  return `You are a Certified Public Accountant. Below is a CLOSED list of reporting
categories that ALREADY EXIST in a Chart of Accounts, each previously approved
by a human or copied from a client's own reference workbook.

Your ONLY job: for each account below, pick the SINGLE existing category from
the list it belongs under, based on what KIND of account it is — e.g. a
credit card account belongs with other credit card accounts regardless of
which bank issued it; a vehicle fuel/repair expense belongs with other
vehicle expenses regardless of which vehicle or vendor; a new bank's checking
account belongs with other bank accounts.

Rules:
  • Copy the category string EXACTLY as written in the list — do not
    paraphrase, abbreviate, reorder, or alter it in any way.
  • If NONE of the existing categories are a good fit — this represents a
    genuinely new kind of account never seen in this list before (e.g. a
    cryptocurrency asset, a carbon-credit liability, a deferred-revenue
    concept with no equivalent above) — return category: null. Do not force
    a weak fit just to avoid returning null.
  • Never invent a new category name. Only choose from the numbered list, or null.
  • confidence reflects genuine certainty this account belongs in that exact
    category, not merely that it's a plausible guess.

EXISTING CATEGORIES:
${catList}

ACCOUNTS TO PLACE:
${acctLines}

Return STRICT JSON only — no markdown, no prose:
{
  "placements": [
    { "key": "<echo exactly>", "category": "<exact string from the list, or null>", "confidence": 0.90 }
  ]
}`;
}

/**
 * @param {Array<{key: string, accountName: string, accountType?: string}>} accounts
 * @param {string[]} categoryPaths — closed list of existing category path strings
 * @returns {Promise<Map<string, {category: string, confidence: number}>>}
 */
async function selectCategoryForAccounts(accounts, categoryPaths) {
  const out = new Map();
  if (!accounts?.length || !categoryPaths?.length) return out;
  if (!process.env.GEMINI_API_KEY) return out;

  const pathSet = new Set(categoryPaths);

  for (let i = 0; i < accounts.length; i += SELECT_BATCH_SIZE) {
    const batch = accounts.slice(i, i + SELECT_BATCH_SIZE);
    try {
      const text = await callGeminiText(buildSelectPrompt(batch, categoryPaths));
      const parsed = parseJsonFromText(text);
      const rows = Array.isArray(parsed?.placements) ? parsed.placements : [];

      for (const r of rows) {
        const key = String(r?.key || "").trim();
        if (!key) continue;
        const category = r.category ? String(r.category).trim() : null;
        const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
        // Hard-reject anything not verbatim on the closed list — a
        // paraphrased or invented label must never pass through.
        if (category && pathSet.has(category) && confidence >= MIN_CATEGORY_CONFIDENCE) {
          out.set(key, { category, confidence });
        }
      }
    } catch (err) {
      console.warn(`[CoaCategorySelector] batch ${Math.floor(i / SELECT_BATCH_SIZE) + 1} failed: ${err.message}`);
    }
  }
  return out;
}

module.exports = { selectCategoryForAccounts, MIN_CATEGORY_CONFIDENCE };
