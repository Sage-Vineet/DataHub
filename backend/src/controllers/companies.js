const { supabase } = require("../db");
const bcrypt = require("bcryptjs");
const asyncHandler = require("../utils");
const { ensureCompanyDefaultFolders } = require("../utils/defaultFolders");
const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

async function syncCompanyClientRepresentative(company, previousCompany = null) {
  if (!company?.id || !company.contact_email || !company.contact_name) return;

  const normalizedEmail = String(company.contact_email).trim().toLowerCase();
  if (!normalizedEmail) return;

  const previousNormalizedEmail = String(previousCompany?.contact_email || "").trim().toLowerCase();

  let existingUser = null;

  if (
    previousCompany?.id
    && previousNormalizedEmail
    && previousNormalizedEmail !== normalizedEmail
  ) {
    const { data: previousContactUsers } = await supabase
      .from("users")
      .select("id, role")
      .eq("company_id", previousCompany.id)
      .eq("role", "buyer")
      .ilike("email", previousNormalizedEmail)
      .maybeSingle();

    existingUser = previousContactUsers || null;
  }

  if (!existingUser) {
    const { data: users } = await supabase
      .from("users")
      .select("id, role")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    existingUser = users || null;
  }

  if (existingUser && existingUser.role !== "buyer") {
    return existingUser.id;
  }

  if (existingUser) {
    await supabase
      .from("users")
      .update({
        name: company.contact_name,
        email: normalizedEmail,
        phone: company.contact_phone || null,
        company_id: company.id,
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingUser.id);

    await supabase
      .from("user_companies")
      .upsert({ user_id: existingUser.id, company_id: company.id }, { onConflict: "user_id,company_id" });
    
    return existingUser.id;
  }

  const passwordHash = await bcrypt.hash(CLIENT_STATIC_PASSWORD, 10);
  const { data: createdUser, error: insertError } = await supabase
    .from("users")
    .insert({
      name: company.contact_name,
      email: normalizedEmail,
      phone: company.contact_phone || null,
      password_hash: passwordHash,
      role: "buyer",
      company_id: company.id,
      status: "active"
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("❌ Error creating company representative:", insertError.message);
    return null;
  }

  if (createdUser) {
    await supabase
      .from("user_companies")
      .upsert({ user_id: createdUser.id, company_id: company.id }, { onConflict: "user_id,company_id" });
  }

  return createdUser?.id || null;
}

const listCompanies = asyncHandler(async (req, res) => {
  // Fetch all companies
  const { data: companies, error: companiesError } = await supabase
    .from("companies")
    .select("*")
    .order("created_at", { ascending: false });

  if (companiesError) return res.status(500).json({ error: companiesError.message });

  // Fetch counts from requests table
  const { data: counts, error: countsError } = await supabase
    .from("requests")
    .select("company_id, status");

  if (countsError) return res.status(500).json({ error: countsError.message });

  // Aggregate counts in JS
  const companyMap = (companies || []).map(company => {
    const companyRequests = counts.filter(r => String(r.company_id) === String(company.id));
    return {
      ...company,
      request_count: companyRequests.length,
      pending_request_count: companyRequests.filter(r => r.status === 'pending').length,
      completed_request_count: companyRequests.filter(r => r.status === 'completed').length,
    };
  });

  res.json(companyMap);
});


const createCompany = asyncHandler(async (req, res) => {
  const {
    name,
    industry,
    status,
    since,
    logo,
    contact_name,
    contact_email,
    contact_phone,
  } = req.body || {};

  if (!name || !industry || !contact_name || !contact_email || !contact_phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const { data: inserted, error } = await supabase
    .from("companies")
    .insert({
      name,
      industry,
      status: status || "active",
      since: since || null,
      logo: logo || null,
      contact_name,
      contact_email,
      contact_phone
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const clientRepresentativeId = inserted ? await syncCompanyClientRepresentative(inserted) : null;
  if (inserted) {
    await ensureCompanyDefaultFolders(inserted.id, req.user?.id || clientRepresentativeId || null);
  }

  res.status(201).json(inserted);
});

const getCompany = asyncHandler(async (req, res) => {
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (companyError) return res.status(500).json({ error: companyError.message });
  if (!company) return res.status(404).json({ error: "Not found" });

  // Fetch counts for this company
  const { data: counts, error: countsError } = await supabase
    .from("requests")
    .select("status")
    .eq("company_id", req.params.id);

  if (countsError) return res.status(500).json({ error: countsError.message });

  const result = {
    ...company,
    request_count: (counts || []).length,
    pending_request_count: (counts || []).filter(r => r.status === 'pending').length,
    completed_request_count: (counts || []).filter(r => r.status === 'completed').length,
  };

  res.json(result);
});


const updateCompany = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const { data: existingCompany, error: findError } = await supabase
    .from("companies")
    .select("*")
    .eq("id", req.params.id)
    .maybeSingle();

  if (findError || !existingCompany) return res.status(404).json({ error: "Not found" });

  const updates = { ...body, updated_at: new Date().toISOString() };
  
  const { data: updated, error } = await supabase
    .from("companies")
    .update(updates)
    .eq("id", req.params.id)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  const clientRepresentativeId = await syncCompanyClientRepresentative(updated, existingCompany);
  await ensureCompanyDefaultFolders(updated.id, req.user?.id || clientRepresentativeId || null);
  res.json(updated);
});

module.exports = { listCompanies, createCompany, getCompany, updateCompany };