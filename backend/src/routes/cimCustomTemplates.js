const express = require("express");
const { supabase } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { isBroker, canAccessCompany } = require("../services/permissionService");
const { buildUploadContentUrl } = require("../utils/uploadStorage");

const router = express.Router();

router.use(requireAuth);

function mapRow(row, req) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    uploadId: row.upload_id,
    fileUrl: buildUploadContentUrl(req, row.upload_id),
    fileName: row.file_name,
    fileSize: row.file_size,
    signature: row.signature,
    schema: row.schema || {},
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.post("/cim-custom-templates", async (req, res) => {
  if (!isBroker(req.user)) {
    return res.status(403).json({ error: "Only brokers can upload custom CIM templates." });
  }

  const { companyId, uploadId, fileName, fileSize, signature, schema } = req.body || {};
  if (!companyId || !uploadId || !fileName || !signature) {
    return res.status(400).json({ error: "companyId, uploadId, fileName and signature are required." });
  }
  if (!canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "You do not have permission to access this company." });
  }

  try {
    const { error: deactivateError } = await supabase
      .from("cim_custom_templates")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("company_id", companyId)
      .eq("is_active", true);
    if (deactivateError) throw deactivateError;

    const { data, error } = await supabase
      .from("cim_custom_templates")
      .insert({
        company_id: companyId,
        upload_id: uploadId,
        file_name: String(fileName).slice(0, 255),
        file_size: Number.isFinite(Number(fileSize)) ? Number(fileSize) : null,
        signature: String(signature),
        schema: schema && typeof schema === "object" ? schema : {},
        is_active: true,
        created_by: req.user?.id || null,
      })
      .select()
      .single();
    if (error) throw error;

    return res.status(201).json({ template: mapRow(data, req) });
  } catch (error) {
    console.error("[CIM Custom Templates] save failed", error);
    return res.status(500).json({ error: "Failed to save the custom CIM template." });
  }
});

router.get("/cim-custom-templates/:companyId", async (req, res) => {
  const { companyId } = req.params;
  if (!canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "You do not have permission to access this company." });
  }

  try {
    const { data, error } = await supabase
      .from("cim_custom_templates")
      .select("*")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    return res.json({ template: mapRow(data, req) });
  } catch (error) {
    console.error("[CIM Custom Templates] load failed", error);
    return res.status(500).json({ error: "Failed to load the custom CIM template." });
  }
});

module.exports = router;
