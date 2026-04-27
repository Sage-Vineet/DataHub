const { supabase } = require("../db");

const DEFAULT_FOLDER_STRUCTURE = [
  { name: "Finance" },
  { name: "Compliance" },
  { name: "HR" },
  { name: "Legal" },
  { name: "M&A" },
  { name: "Tax" },
  { name: "Other" },
];

async function userExists(userId) {
  if (!userId) return false;
  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  return !!data && !error;
}

async function resolveFolderCreatorId(companyId, preferredCreatedBy) {
  if (await userExists(preferredCreatedBy)) return preferredCreatedBy;

  const { data: companyUser } = await supabase
    .from("users")
    .select("id")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (companyUser?.id) return companyUser.id;

  const { data: assignedUser } = await supabase
    .from("user_companies")
    .select("user_id")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (assignedUser?.user_id) return assignedUser.user_id;

  const { data: brokerUser } = await supabase
    .from("users")
    .select("id")
    .in("role", ["admin", "broker"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return brokerUser?.id || null;
}

async function ensureCompanyDefaultFolders(companyId, preferredCreatedBy) {
  if (!companyId) return [];

  const { data: existingRows, error: findError } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (findError) return [];
  if (existingRows && existingRows.length > 0) return existingRows;

  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) return [];

  for (const folder of DEFAULT_FOLDER_STRUCTURE) {
    const { data: parent, error: insertError } = await supabase
      .from("folders")
      .insert({
        company_id: companyId,
        parent_id: null,
        name: folder.name,
        color: null,
        created_by: creatorId
      })
      .select("*")
      .single();

    if (insertError) {
      console.error("❌ Error creating folder:", insertError.message);
      continue;
    }

    if (parent && Array.isArray(folder.children)) {
      const children = folder.children.map(childName => ({
        company_id: companyId,
        parent_id: parent.id,
        name: childName,
        color: null,
        created_by: creatorId
      }));
      await supabase.from("folders").insert(children);
    }
  }

  const { data: finalFolders } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  return finalFolders || [];
}

async function ensureRootUploadFolder(companyId, preferredCreatedBy) {
  const { data: existing, error: findError } = await supabase
    .from("folders")
    .select("*")
    .eq("company_id", companyId)
    .is("parent_id", null)
    .ilike("name", "General Uploads")
    .maybeSingle();

  if (existing) return existing;

  const creatorId = await resolveFolderCreatorId(companyId, preferredCreatedBy);
  if (!creatorId) return null;

  const { data: created, error: insertError } = await supabase
    .from("folders")
    .insert({
      company_id: companyId,
      parent_id: null,
      name: "General Uploads",
      color: null,
      created_by: creatorId
    })
    .select("*")
    .single();

  if (insertError) console.error("❌ Error creating root upload folder:", insertError.message);
  return created || null;
}

module.exports = {
  ensureCompanyDefaultFolders,
  ensureRootUploadFolder,
  resolveFolderCreatorId,
};

