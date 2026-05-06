const { supabase } = require("../db");

function parsePayload(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

async function getWorkspacePageState(companyId, pageKey) {
  if (!companyId || !pageKey) return null;

  const { data, error } = await supabase
    .from("workspace_page_state")
    .select("company_id, page_key, payload, created_at, updated_at")
    .eq("company_id", companyId)
    .eq("page_key", pageKey)
    .maybeSingle();

  if (error || !data) return null;

  return {
    companyId: data.company_id,
    pageKey: data.page_key,
    payload: parsePayload(data.payload),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

async function replaceWorkspacePageState(companyId, pageKey, payload) {
  if (!companyId || !pageKey) {
    throw new Error("Missing companyId or pageKey while saving workspace state.");
  }

  const { data, error } = await supabase
    .from("workspace_page_state")
    .upsert({
      company_id: companyId,
      page_key: pageKey,
      payload: payload ?? {},
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,page_key" })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Workspace state save failed: ${error.message}`);
  }

  return {
    companyId: data.company_id,
    pageKey: data.page_key,
    payload: parsePayload(data.payload),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

async function deleteWorkspacePageState(companyId, pageKey) {
  if (!companyId || !pageKey) return false;

  const { error } = await supabase
    .from("workspace_page_state")
    .delete()
    .eq("company_id", companyId)
    .eq("page_key", pageKey);

  if (error) {
    console.error("Error deleting workspace state:", error.message);
    return false;
  }

  return true;
}

module.exports = {
  getWorkspacePageState,
  replaceWorkspacePageState,
  deleteWorkspacePageState,
};

