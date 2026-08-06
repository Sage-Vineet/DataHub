const express = require("express");
const { supabase } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { canAccessCompany } = require("../services/permissionService");

const router = express.Router();
router.use(requireAuth);

function getClientId(req) {
  return req.headers["x-client-id"] || req.query.clientId || req.body?.clientId;
}

router.get("/bank-reconciliation-adjustments", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId" });
  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }
  try {
    const { data, error } = await supabase
      .from("bank_reconciliation_adjustments")
      .select("month, row_key, amount")
      .eq("company_id", clientId)
      .order("month", { ascending: true });
    if (error) throw error;
    return res.json({
      success: true,
      adjustments: (data || []).map((r) => ({
        month: r.month,
        rowKey: r.row_key,
        amount: Number(r.amount),
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/bank-reconciliation-adjustments", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId" });
  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }
  const { month, rowKey, amount } = req.body;
  if (!month || !rowKey) {
    return res.status(400).json({ success: false, error: "Missing month or rowKey" });
  }
  const numAmount = Number(amount) || 0;
  try {
    const { error } = await supabase
      .from("bank_reconciliation_adjustments")
      .upsert(
        {
          company_id: clientId,
          month,
          row_key: rowKey,
          amount: numAmount,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "company_id,month,row_key" }
      );
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Addback Items CRUD ────────────────────────────────────────────────────────

router.get("/bank-reconciliation-addback-items", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId" });
  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }
  const { section, reportSource } = req.query;
  const keyReportVersionId = String(req.query.keyReportVersionId || "").trim() || null;
  if (!reportSource) {
    return res.status(400).json({ success: false, error: "Missing reportSource" });
  }
  try {
    // Key Reports mode passes a keyReportVersionId so each version keeps its own
    // addbacks; the 4 connection modes pass none (key_report_version_id IS NULL).
    const buildQuery = (withVersionScope) => {
      let q = supabase
        .from("bank_reconciliation_addback_items")
        .select("id, section, name, source, month_amounts, sort_order, report_source")
        .eq("company_id", clientId)
        .eq("report_source", reportSource)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (section) q = q.eq("section", section);
      if (withVersionScope) {
        q = keyReportVersionId
          ? q.eq("key_report_version_id", keyReportVersionId)
          : q.is("key_report_version_id", null);
      }
      return q;
    };

    const isVersionColumnErr = (err) => {
      if (!err) return false;
      const str = String(err.message || err.details || err.hint || JSON.stringify(err));
      return /key_report_version_id/i.test(str) || err.code === "PGRST204" || err.code === "42703";
    };

    let { data, error } = await buildQuery(true);
    // Graceful fallback if migration 066 (key_report_version_id) is not applied.
    if (error && isVersionColumnErr(error)) {
      ({ data, error } = await buildQuery(false));
    }
    if (error) throw error;
    return res.json({
      success: true,
      items: (data || []).map((r) => ({
        id: r.id,
        section: r.section,
        name: r.name,
        source: r.source,
        monthAmounts: r.month_amounts || {},
        sortOrder: r.sort_order,
        reportSource: r.report_source,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/bank-reconciliation-addback-items", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId" });
  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }
  const { section, name, source, monthAmounts, reportSource } = req.body;
  const keyReportVersionId = req.body?.keyReportVersionId || null;
  if (!section || !name || !reportSource) {
    return res.status(400).json({ success: false, error: "Missing section, name, or reportSource" });
  }
  try {
    const baseRow = {
      company_id: clientId,
      section,
      name,
      source: source || "manual",
      month_amounts: monthAmounts || {},
      report_source: reportSource,
    };
    const insertRow = (withVersion) =>
      supabase
        .from("bank_reconciliation_addback_items")
        .insert(withVersion ? { ...baseRow, key_report_version_id: keyReportVersionId } : baseRow)
        .select("id, section, name, source, month_amounts, sort_order, report_source")
        .single();

    let { data, error } = await insertRow(true);
    // Graceful fallback if migration 066 (key_report_version_id) is not applied.
    if (error && isVersionColumnErr(error)) {
      ({ data, error } = await insertRow(false));
    }
    if (error) throw error;
    return res.json({
      success: true,
      item: {
        id: data.id,
        section: data.section,
        name: data.name,
        source: data.source,
        monthAmounts: data.month_amounts || {},
        sortOrder: data.sort_order,
        reportSource: data.report_source,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/bank-reconciliation-addback-items/:id", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId" });
  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }
  const { id } = req.params;
  const { monthAmounts } = req.body;
  try {
    const { error } = await supabase
      .from("bank_reconciliation_addback_items")
      .update({ month_amounts: monthAmounts || {}, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("company_id", clientId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/bank-reconciliation-addback-items/:id", async (req, res) => {
  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ success: false, error: "Missing clientId" });
  if (!canAccessCompany(req.user, clientId)) {
    return res.status(403).json({ success: false, error: "Access denied" });
  }
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from("bank_reconciliation_addback_items")
      .delete()
      .eq("id", id)
      .eq("company_id", clientId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
