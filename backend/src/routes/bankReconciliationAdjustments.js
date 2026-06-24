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
  if (!reportSource) {
    return res.status(400).json({ success: false, error: "Missing reportSource" });
  }
  try {
    let query = supabase
      .from("bank_reconciliation_addback_items")
      .select("id, section, name, source, month_amounts, sort_order, report_source")
      .eq("company_id", clientId)
      .eq("report_source", reportSource)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (section) query = query.eq("section", section);
    const { data, error } = await query;
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
  if (!section || !name || !reportSource) {
    return res.status(400).json({ success: false, error: "Missing section, name, or reportSource" });
  }
  try {
    const { data, error } = await supabase
      .from("bank_reconciliation_addback_items")
      .insert({
        company_id: clientId,
        section,
        name,
        source: source || "manual",
        month_amounts: monthAmounts || {},
        report_source: reportSource,
      })
      .select("id, section, name, source, month_amounts, sort_order, report_source")
      .single();
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
