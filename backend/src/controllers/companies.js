const asyncHandler = require("../utils");
const { ensureCompanyDefaultFolders } = require("../services/folderService");
const companyService = require("../services/companyService");

const listCompanies = asyncHandler(async (req, res) => {
  const companies = await companyService.getAllCompanies();
  res.json(companies);
});

const createCompany = asyncHandler(async (req, res) => {
  const { name, project_name, industry, contact_name, contact_email, contact_phone } = req.body || {};

  if (!name || !project_name || !industry || !contact_name || !contact_email || !contact_phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const inserted = await companyService.createCompany(req.body);
  
  const clientRepresentativeId = await companyService.syncCompanyClientRepresentative(inserted);
  await ensureCompanyDefaultFolders(inserted.id, req.user?.id || clientRepresentativeId || null);

  res.status(201).json(inserted);
});

const getCompany = asyncHandler(async (req, res) => {
  const company = await companyService.getCompanyById(req.params.id);
  if (!company) return res.status(404).json({ error: "Not found" });
  res.json(company);
});

const updateCompany = asyncHandler(async (req, res) => {
  const existingCompany = await companyService.getCompanyById(req.params.id);
  if (!existingCompany) return res.status(404).json({ error: "Not found" });

  const updated = await companyService.updateCompany(req.params.id, req.body);
  
  const clientRepresentativeId = await companyService.syncCompanyClientRepresentative(updated, existingCompany);
  await ensureCompanyDefaultFolders(updated.id, req.user?.id || clientRepresentativeId || null);
  
  res.json(updated);
});

const deleteCompany = asyncHandler(async (req, res) => {
  const existing = await companyService.getCompanyById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });

  await companyService.deleteCompany(req.params.id);
  res.status(200).json({ message: "Company deleted successfully" });
});

module.exports = { listCompanies, createCompany, getCompany, updateCompany, deleteCompany };