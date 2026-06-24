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

function isMissingWorkspaceTableError(error) {
  if (!error) return false;
  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    (
      message.includes("workspace_page_state") &&
      (
        message.includes("does not exist") ||
        message.includes("could not find") ||
        message.includes("not found")
      )
    )
  );
}

function getFallbackPreferenceKey(companyId, pageKey) {
  return `workspace_page_state:${companyId}:${pageKey}`;
}

function mapPreferenceState(data, companyId, pageKey) {
  if (!data) return null;
  const value = parsePayload(data.pref_value) || {};

  return {
    companyId: value.companyId || companyId,
    pageKey: value.pageKey || pageKey,
    payload: parsePayload(value.payload),
    createdAt: data.created_at,
    updatedAt: value.updatedAt || data.updated_at,
  };
}

async function getFallbackWorkspacePageState(companyId, pageKey, userId) {
  if (!companyId || !pageKey || !userId) return null;

  const { data, error } = await supabase
    .from("user_preferences")
    .select("pref_value, created_at, updated_at")
    .eq("user_id", userId)
    .eq("pref_key", getFallbackPreferenceKey(companyId, pageKey))
    .maybeSingle();

  if (error || !data) return null;

  return mapPreferenceState(data, companyId, pageKey);
}

async function getSharedFallbackWorkspacePageState(companyId, pageKey) {
  if (!companyId || !pageKey) return null;

  const { data, error } = await supabase
    .from("user_preferences")
    .select("pref_value, created_at, updated_at")
    .eq("pref_key", getFallbackPreferenceKey(companyId, pageKey))
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return mapPreferenceState(data, companyId, pageKey);
}

async function replaceFallbackWorkspacePageState(companyId, pageKey, payload, userId) {
  if (!companyId || !pageKey || !userId) return null;

  const now = new Date().toISOString();
  const prefValue = {
    companyId,
    pageKey,
    payload: payload ?? {},
    updatedAt: now,
  };

  const { data, error } = await supabase
    .from("user_preferences")
    .upsert({
      user_id: userId,
      pref_key: getFallbackPreferenceKey(companyId, pageKey),
      pref_value: prefValue,
      updated_at: now,
    }, { onConflict: "user_id,pref_key" })
    .select("pref_value, created_at, updated_at")
    .single();

  if (error) {
    throw new Error(`Workspace state fallback save failed: ${error.message}`);
  }

  return mapPreferenceState(data, companyId, pageKey);
}

async function replaceSharedFallbackWorkspacePageState(companyId, pageKey, payload, userId) {
  return replaceFallbackWorkspacePageState(companyId, pageKey, payload, userId);
}

async function deleteFallbackWorkspacePageState(companyId, pageKey, userId) {
  if (!companyId || !pageKey || !userId) return false;

  const { error } = await supabase
    .from("user_preferences")
    .delete()
    .eq("user_id", userId)
    .eq("pref_key", getFallbackPreferenceKey(companyId, pageKey));

  return !error;
}

async function getWorkspacePageState(companyId, pageKey, userId = null) {
  if (!companyId || !pageKey) return null;

  const { data, error } = await supabase
    .from("workspace_page_state")
    .select("company_id, page_key, payload, created_at, updated_at")
    .eq("company_id", companyId)
    .eq("page_key", pageKey)
    .maybeSingle();

  if (error) {
    if (isMissingWorkspaceTableError(error)) {
      return getFallbackWorkspacePageState(companyId, pageKey, userId);
    }
    return null;
  }
  if (!data) {
    return getFallbackWorkspacePageState(companyId, pageKey, userId);
  }

  return {
    companyId: data.company_id,
    pageKey: data.page_key,
    payload: parsePayload(data.payload),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

async function getSharedWorkspacePageState(companyId, pageKey, userId = null) {
  if (!companyId || !pageKey) return null;

  const { data, error } = await supabase
    .from("workspace_page_state")
    .select("company_id, page_key, payload, created_at, updated_at")
    .eq("company_id", companyId)
    .eq("page_key", pageKey)
    .maybeSingle();

  if (error) {
    if (isMissingWorkspaceTableError(error)) {
      return getSharedFallbackWorkspacePageState(companyId, pageKey);
    }
    return getSharedFallbackWorkspacePageState(companyId, pageKey);
  }
  if (!data) {
    return getSharedFallbackWorkspacePageState(companyId, pageKey);
  }

  return {
    companyId: data.company_id,
    pageKey: data.page_key,
    payload: parsePayload(data.payload),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

async function replaceWorkspacePageState(companyId, pageKey, payload, userId = null) {
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
    if (isMissingWorkspaceTableError(error) && userId) {
      return replaceFallbackWorkspacePageState(companyId, pageKey, payload, userId);
    }
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

async function replaceSharedWorkspacePageState(companyId, pageKey, payload, userId = null) {
  if (!companyId || !pageKey) {
    throw new Error("Missing companyId or pageKey while saving shared workspace state.");
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
    if (userId) {
      return replaceSharedFallbackWorkspacePageState(companyId, pageKey, payload, userId);
    }
    throw new Error(`Shared workspace state save failed: ${error.message}`);
  }

  return {
    companyId: data.company_id,
    pageKey: data.page_key,
    payload: parsePayload(data.payload),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

async function deleteWorkspacePageState(companyId, pageKey, userId = null) {
  if (!companyId || !pageKey) return false;

  const { error } = await supabase
    .from("workspace_page_state")
    .delete()
    .eq("company_id", companyId)
    .eq("page_key", pageKey);

  if (error) {
    if (isMissingWorkspaceTableError(error) && userId) {
      return deleteFallbackWorkspacePageState(companyId, pageKey, userId);
    }
    console.error("Error deleting workspace state:", error.message);
    return false;
  }

  return true;
}

module.exports = {
  getWorkspacePageState,
  replaceWorkspacePageState,
  deleteWorkspacePageState,
  getSharedWorkspacePageState,
  replaceSharedWorkspacePageState,
};
