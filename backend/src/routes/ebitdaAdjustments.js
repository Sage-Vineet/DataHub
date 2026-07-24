const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany } = require("../services/permissionService");
const {
  listAdjustmentTypes,
  listEbitdaAdjustments,
  saveEbitdaAdjustmentsBatch,
  deleteEbitdaAdjustment,
  addEbitdaComment,
  normalizeScope,
} = require("../services/ebitdaAdjustmentStore");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getGeminiModels } = require("../config/geminiModels");

// Dynamically selected via GEMINI_MODELS / GEMINI_MODEL env; this array is the
// default fallback order used when no override is configured.
const GEMINI_MODELS = getGeminiModels(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]);

const router = express.Router();

router.use(requireAuth);

function resolveClientId(req) {
  let clientId = req.headers["x-client-id"] || req.query.clientId;
  if (!clientId && req.headers.referer) {
    const match =
      req.headers.referer.match(/\/client\/([^/]+)/) ||
      req.headers.referer.match(/\/workspace\/([^/]+)/);
    if (match) clientId = match[1];
  }
  return clientId;
}

function requireClientAccess(req, res, clientId) {
  if (!clientId) {
    res.status(400).json({ success: false, error: "Missing clientId." });
    return false;
  }
  if (!canAccessCompany(req.user, clientId)) {
    res.status(403).json({ success: false, error: "You do not have permission to access this company." });
    return false;
  }
  return true;
}

function normalizeRequestScope(req) {
  return normalizeScope({
    companyId: resolveClientId(req),
    versionId: req.query.versionId || req.body?.versionId,
    sourceKey: req.query.sourceKey || req.body?.sourceKey || "manual_gl",
    datasetVersionId: req.query.datasetVersionId || req.body?.datasetVersionId,
    uploadBatchId: req.query.uploadBatchId || req.body?.uploadBatchId,
  });
}

router.get("/ebitda-adjustment-types", async (_req, res) => {
  try {
    const types = await listAdjustmentTypes();
    return res.json({ success: true, types });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to load EBITDA adjustment types.",
    });
  }
});

router.get("/ebitda-adjustments", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const payload = await listEbitdaAdjustments(scope);
    return res.json({ success: true, ...payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to load EBITDA adjustments.",
    });
  }
});

router.post("/ebitda-adjustments/batch", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const result = await saveEbitdaAdjustmentsBatch(
      {
        ...scope,
        adjustments: req.body?.adjustments || [],
      },
      req.user?.id || null,
    );

    const refreshed = await listEbitdaAdjustments(scope);
    return res.json({
      success: true,
      ...result,
      ...refreshed,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to save EBITDA adjustments.",
    });
  }
});

router.delete("/ebitda-adjustments/:id", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const result = await deleteEbitdaAdjustment(req.params.id, scope, req.user?.id || null);
    const refreshed = await listEbitdaAdjustments(scope);
    return res.json({
      success: true,
      ...result,
      ...refreshed,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to delete EBITDA adjustment.",
    });
  }
});

router.post("/ebitda-adjustments/:id/comments", async (req, res) => {
  try {
    const scope = normalizeRequestScope(req);
    if (!requireClientAccess(req, res, scope.companyId)) return;
    if (!scope.versionId) {
      return res.status(400).json({ success: false, error: "Missing versionId." });
    }

    const comment = await addEbitdaComment(req.params.id, scope, req.body || {}, req.user?.id || null);
    return res.status(201).json({ success: true, comment });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to add EBITDA comment.",
    });
  }
});

// ── AI-generated EBITDA comments ────────────────────────────────────────────
// POST /ebitda/generate-comments
// Body: { companyName, years, ebitdaData, adjustments, finalLabel, percentLabel }
// Returns: { comments: { netIncome, interestIncome, ... } }
router.post("/ebitda/generate-comments", async (req, res) => {
  try {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ success: false, error: "AI service not configured." });
  }

  const {
    companyName = "the company",
    years = [],
    ebitdaData = {},
    adjustments = [],
    finalLabel = "Adjusted EBITDA",
    percentLabel = "EBITDA % of Sales",
  } = req.body || {};

  const fmt = (v) => (v == null || v === "" ? "N/A" : Number(v).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
  const fmtPct = (v) => (v == null || v === "" ? "N/A" : `${Number(v).toFixed(2)}%`);

  // Build a structured financial summary for Gemini to analyse
  const rows = [
    { key: "netIncome",       label: "Net Income" },
    { key: "interestIncome",  label: "Total Interest Income" },
    { key: "interestExpense", label: "Total Interest Expense" },
    { key: "taxes",           label: "Total Income Tax Expense" },
    { key: "depreciation",    label: "Depreciation" },
    { key: "amortization",    label: "Amortization Expense" },
    { key: "ebitda",          label: "EBITDA" },
    { key: "totalSde",        label: finalLabel },
    { key: "sdePercent",      label: percentLabel },
  ];

  const tableLines = rows.map(({ key, label }) => {
    const vals = years.map((yr) => {
      const v = ebitdaData[yr]?.[key];
      return key === "sdePercent" ? fmtPct(v) : fmt(v);
    });
    return `  ${label}: ${vals.join(" | ")}`;
  });

  const adjLines = adjustments.length
    ? adjustments.map((a) => {
        const vals = years.map((yr) => fmt(a.values?.[yr]?.value ?? a.values?.[yr]?.apiValue)).join(" | ");
        return `  ${a.label}: ${vals}`;
      })
    : ["  (none)"];

  const prompt = `You are a senior M&A financial analyst. Analyse the following EBITDA data for ${companyName} and write a concise, insightful analytical comment for EACH row. Comments should be 1-2 sentences, professional, and highlight trends, anomalies, or significance of the value.

YEARS: ${years.join(" | ")}

EBITDA TABLE:
${tableLines.join("\n")}

ADJUSTMENTS / ADD-BACKS:
${adjLines.join("\n")}

Return ONLY a raw JSON object with these exact keys (no markdown, no explanation):
{
  "netIncome": "...",
  "interestIncome": "...",
  "interestExpense": "...",
  "taxes": "...",
  "depreciation": "...",
  "amortization": "...",
  "ebitda": "...",
  "totalSde": "...",
  "sdePercent": "..."
}`;

  for (const modelName of GEMINI_MODELS) {
    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      let text = result.response.text().trim()
        .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const comments = JSON.parse(text);
      // Ensure all expected keys exist
      rows.forEach(({ key }) => { if (!comments[key]) comments[key] = ""; });
      return res.json({ success: true, comments });
    } catch (err) {
      console.warn(`[EbitdaComments] model=${modelName} failed: ${err.message}`);
    }
  }

  return res.status(500).json({ success: false, error: "Failed to generate comments after all retries." });
  } catch (err) {
    console.error("[EbitdaComments] Unexpected error:", err.message, err.stack);
    return res.status(500).json({ success: false, error: err.message || "Unexpected server error." });
  }
});

module.exports = router;
