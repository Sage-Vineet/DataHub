const { supabase } = require("../db");
const bcrypt = require("bcryptjs");
const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

/**
 * Standard company select fields
 */
const companySelect = "*";

/**
 * Gets all companies with stats
 * @returns {Promise<Array>}
 */
async function getAllCompanies() {
  const { data: companies, error } = await supabase
    .from("companies")
    .select(companySelect)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return await attachCompanyStats(companies || []);
}

/**
 * Gets a company by ID with stats
 * @param {string} id - Company ID
 * @returns {Promise<Object|null>}
 */
async function getCompanyById(id) {
  const { data: company, error } = await supabase
    .from("companies")
    .select(companySelect)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!company) return null;

  return await attachCompanyStats(company);
}

/**
 * Creates a new company
 * @param {Object} companyData - Company data
 * @returns {Promise<Object>} Created company
 */
async function createCompany(companyData) {
  const { data: inserted, error } = await supabase
    .from("companies")
    .insert({
      name: companyData.name,
      industry: companyData.industry,
      status: companyData.status || "active",
      since: companyData.since || null,
      logo: companyData.logo || null,
      contact_name: companyData.contact_name,
      contact_email: companyData.contact_email,
      contact_phone: companyData.contact_phone
    })
    .select("*")
    .single();

  if (error) throw error;
  return inserted;
}

/**
 * Updates an existing company
 * @param {string} id - Company ID
 * @param {Object} companyData - Update data
 * @returns {Promise<Object>} Updated company
 */
async function updateCompany(id, companyData) {
  const updates = { ...companyData, updated_at: new Date().toISOString() };
  
  const { data: updated, error } = await supabase
    .from("companies")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return updated;
}

/**
 * Syncs a company's client representative (buyer user) based on contact info.
 * Creates a new user if one doesn't exist, or updates an existing one.
 * @param {Object} company - The current company data
 * @param {Object} previousCompany - The previous company data (optional)
 * @returns {Promise<string|null>} The user ID of the representative
 */
async function syncCompanyClientRepresentative(company, previousCompany = null) {
  if (!company?.id || !company.contact_email || !company.contact_name) return null;

  const normalizedEmail = String(company.contact_email).trim().toLowerCase();
  if (!normalizedEmail) return null;

  const previousNormalizedEmail = String(previousCompany?.contact_email || "").trim().toLowerCase();

  let existingUser = null;

  // If email changed, check if the old email belongs to a buyer in this company
  if (
    previousCompany?.id &&
    previousNormalizedEmail &&
    previousNormalizedEmail !== normalizedEmail
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

  // If not found by change logic, check global email
  if (!existingUser) {
    const { data: users } = await supabase
      .from("users")
      .select("id, role")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    existingUser = users || null;
  }

  // If user exists but is not a buyer (broker/admin), don't touch but return ID
  if (existingUser && existingUser.role !== "buyer") {
    return existingUser.id;
  }

  if (existingUser) {
    // Update existing buyer user
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

    // Ensure they are assigned to the company
    await supabase
      .from("user_companies")
      .upsert({ user_id: existingUser.id, company_id: company.id }, { onConflict: "user_id,company_id" });
    
    return existingUser.id;
  }

  // Create new buyer user
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

/**
 * Attaches request statistics to a company or list of companies
 * @param {Object|Array} companies - Company or companies to enrich
 * @returns {Promise<Object|Array>} Enriched company(s)
 */
async function attachCompanyStats(companies) {
  const isSingle = !Array.isArray(companies);
  const companyList = isSingle ? [companies] : companies;
  
  if (!companyList.length) return companies;

  const companyIds = companyList.map(c => c.id);
  
  const { data: counts, error: countsError } = await supabase
    .from("requests")
    .select("company_id, status")
    .in("company_id", companyIds);

  if (countsError) {
    console.error("❌ Error fetching company stats:", countsError.message);
    return companies;
  }

  const enriched = companyList.map(company => {
    const companyRequests = counts.filter(r => String(r.company_id) === String(company.id));
    return {
      ...company,
      request_count: companyRequests.length,
      pending_request_count: companyRequests.filter(r => r.status === 'pending').length,
      completed_request_count: companyRequests.filter(r => r.status === 'completed').length,
    };
  });

  return isSingle ? enriched[0] : enriched;
}

module.exports = {
  getAllCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  syncCompanyClientRepresentative,
  attachCompanyStats
};
