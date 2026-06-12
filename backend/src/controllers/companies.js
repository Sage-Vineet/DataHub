const asyncHandler = require("../utils");
const { ensureCompanyDefaultFolders } = require("../services/folderService");
const companyService = require("../services/companyService");
const permissionService = require("../services/permissionService");
const userService = require("../services/userService");
const { sendCompanyCreatedEmail } = require("../services/emailService");

const listCompanies = asyncHandler(async (req, res) => {
  const companies = await companyService.getCompaniesForUser(req.user);
  res.json(companies);
});

const createCompany = asyncHandler(async (req, res) => {
  const { name, project_name, industry, contact_name, contact_email, contact_phone } = req.body || {};

  if (!name || !project_name || !industry || !contact_name || !contact_email || !contact_phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const inserted = await companyService.createCompany(req.body);
  if (["broker", "admin"].includes(String(req.user?.role || "").toLowerCase())) {
    await companyService.assignCompanyToUser(req.user.id, inserted.id);
    if (!permissionService.isAdmin(req.user)) {
      req.user.company_ids = Array.from(new Set([...(req.user.company_ids || []), inserted.id]));
    }
  }

  const clientRepresentativeId = await companyService.syncCompanyClientRepresentative(inserted).catch((err) => {
    console.error("[createCompany] syncCompanyClientRepresentative failed (non-fatal):", err.message);
    return null;
  });
  await ensureCompanyDefaultFolders(inserted.id, req.user?.id || clientRepresentativeId || null).catch(() => { });

  res.status(201).json({ ...inserted, emailQueued: true });

  // Fire-and-forget: notify primary contact — must not block or fail company creation
  setImmediate(async () => {
    try {
      const broker = await userService.getUserById(req.user?.id).catch(() => null);
      const portalUrl = process.env.APP_BASE_URL
        ? process.env.APP_BASE_URL.replace(/\/$/, "")
        : (process.env.FRONTEND_URL || "").replace(/\/$/, "");

      const seen = new Set();
      const recipients = [];

      // Primary contact
      if (inserted.contact_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inserted.contact_email)) {
        if (!seen.has(inserted.contact_email.toLowerCase())) {
          seen.add(inserted.contact_email.toLowerCase());
          recipients.push({ name: inserted.contact_name || null, email: inserted.contact_email });
        }
      }

      for (const r of recipients) {
        await sendCompanyCreatedEmail({
          toName:      r.name || null,
          toEmail:     r.email,
          companyName: inserted.name,
          projectName: inserted.project_name || null,
          brokerName:  broker?.name || null,
          portalUrl,
        });
      }

      console.log(`[Audit] [createCompany] Notification emails sent company=${inserted.id} recipients=${recipients.map(r => r.email).join(", ")}`);
    } catch (emailErr) {
      console.error("[createCompany] Email notification failed (non-fatal):", emailErr.message);
    }
  });
});

const getCompany = asyncHandler(async (req, res) => {
  const company = await companyService.getCompanyById(req.params.id);
  if (!company) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, company.id)) {
    return res.status(403).json({ error: "You do not have permission to access this company." });
  }
  res.json(company);
});

const updateCompany = asyncHandler(async (req, res) => {
  const existingCompany = await companyService.getCompanyById(req.params.id);
  if (!existingCompany) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existingCompany.id)) {
    return res.status(403).json({ error: "You do not have permission to update this company." });
  }

  const updated = await companyService.updateCompany(req.params.id, req.body);
  await companyService.syncCompanyClientRepresentative(updated, existingCompany).catch((err) => {
    console.error("[updateCompany] syncCompanyClientRepresentative failed (non-fatal):", err.message);
  });
  res.json(updated);
});

const deleteCompany = asyncHandler(async (req, res) => {
  const existing = await companyService.getCompanyById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.id)) {
    return res.status(403).json({ error: "You do not have permission to delete this company." });
  }

  await companyService.deleteCompany(req.params.id);
  res.status(200).json({ message: "Company deleted successfully" });
});

module.exports = { listCompanies, createCompany, getCompany, updateCompany, deleteCompany };
