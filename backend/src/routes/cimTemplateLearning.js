const express = require("express");
const { supabase } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { isBroker, canAccessCompany } = require("../services/permissionService");

const router = express.Router();

router.use(requireAuth);

function mapEntryRow(row) {
  return {
    semanticMeaning: row.semantic_meaning || "",
    metricKey: row.metric_key || "",
    expectedDataType: row.expected_data_type || "",
    selectedDataSource: row.selected_data_source || "",
    confidence: Number(row.confidence) || 0,
    formattingRules: Array.isArray(row.formatting_rules) ? row.formatting_rules : [],
    approvedAt: row.approved_at,
  };
}

async function upsertMappingRow({ companyId, entry, userId }) {
  const contextSignature = String(entry?.contextSignature || "");
  if (!contextSignature) return;

  let query = supabase
    .from("cim_template_learning_mappings")
    .select("id")
    .eq("context_signature", contextSignature);
  query = companyId ? query.eq("company_id", companyId) : query.is("company_id", null);
  const { data: existing, error: selectError } = await query.maybeSingle();
  if (selectError) throw selectError;

  const payload = {
    company_id: companyId || null,
    context_signature: contextSignature,
    semantic_meaning: entry.semanticMeaning || null,
    metric_key: entry.metricKey || null,
    expected_data_type: entry.expectedDataType || null,
    selected_data_source: entry.selectedDataSource || null,
    confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.8,
    formatting_rules: Array.isArray(entry.formattingRules) ? entry.formattingRules : [],
    approved_by: userId || null,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { error } = await supabase
      .from("cim_template_learning_mappings")
      .update(payload)
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from("cim_template_learning_mappings")
      .insert({ ...payload, approved_at: new Date().toISOString() });
    if (error) throw error;
  }
}

router.get("/cim-template-learning", async (req, res) => {
  if (!isBroker(req.user)) {
    return res.status(403).json({ error: "Only brokers can access CIM template learning." });
  }
  const companyId = req.query.companyId ? String(req.query.companyId) : "";
  if (companyId && !canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "You do not have permission to access this company." });
  }

  try {
    const { data: globalRows, error: globalError } = await supabase
      .from("cim_template_learning_mappings")
      .select("*")
      .is("company_id", null);
    if (globalError) throw globalError;

    let companyRows = [];
    if (companyId) {
      const { data, error } = await supabase
        .from("cim_template_learning_mappings")
        .select("*")
        .eq("company_id", companyId);
      if (error) throw error;
      companyRows = data || [];
    }

    const global = Object.fromEntries((globalRows || []).map((row) => [row.context_signature, mapEntryRow(row)]));
    const company = Object.fromEntries(companyRows.map((row) => [row.context_signature, mapEntryRow(row)]));

    return res.json({ global, company });
  } catch (error) {
    console.error("[CIM Template Learning] load failed", error);
    return res.status(500).json({ error: "Failed to load CIM template learning data." });
  }
});

router.post("/cim-template-learning", async (req, res) => {
  if (!isBroker(req.user)) {
    return res.status(403).json({ error: "Only brokers can save CIM template learning." });
  }
  const { companyId, entries } = req.body || {};
  if (companyId && !canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "You do not have permission to access this company." });
  }
  const list = Array.isArray(entries) ? entries.slice(0, 200) : [];
  if (!list.length) return res.json({ saved: 0 });

  try {
    for (const entry of list) {
      // Every approved mapping strengthens both the company-scoped store and
      // the global store, so other companies' uploads benefit too (mirrors
      // the previous localStorage learning.company / learning.global tiers).
      if (companyId) {
        await upsertMappingRow({ companyId, entry, userId: req.user?.id });
      }
      await upsertMappingRow({ companyId: null, entry, userId: req.user?.id });
    }
    return res.json({ saved: list.length });
  } catch (error) {
    console.error("[CIM Template Learning] save failed", error);
    return res.status(500).json({ error: "Failed to save CIM template learning data." });
  }
});

module.exports = router;
