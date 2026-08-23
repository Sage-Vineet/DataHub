const folderService = require("../services/folderService");
const documentService = require("../services/documentService");
const permissionService = require("../services/permissionService");
const asyncHandler = require("../utils");
const { buildUploadContentUrl } = require("../utils/uploadStorage");

const listFolders = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const folders = await folderService.listFoldersByCompany(req.params.id);
  res.json(folders);
});

const listFolderTree = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const includeArchived = req.query.includeArchived === 'true';
  const tree = await folderService.getFolderTree(req.params.id, { includeArchived });
  res.json(tree);
});

const createFolder = asyncHandler(async (req, res) => {
  if (!permissionService.canAccessCompany(req.user, req.params.id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const folder = await folderService.createFolder(req.params.id, {
    ...req.body,
    created_by: req.body?.created_by || req.user?.id,
  });
  res.status(201).json(folder);
});

const updateFolder = asyncHandler(async (req, res) => {
  const existing = await folderService.getFolderById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const folder = await folderService.updateFolder(req.params.id, req.body);
  res.json(folder);
});

const deleteFolder = asyncHandler(async (req, res) => {
  const existing = await folderService.getFolderById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  await folderService.deleteFolder(req.params.id);
  res.status(204).send();
});

const moveFolder = asyncHandler(async (req, res) => {
  const existing = await folderService.getFolderById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const folder = await folderService.moveFolder(req.params.id, req.body.parent_id);
  res.json(folder);
});

const listFolderDocuments = asyncHandler(async (req, res) => {
  const folder = await folderService.getFolderById(req.params.id);
  if (!folder) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, folder.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const includeArchived = req.query.includeArchived === 'true';
  const documents = await documentService.listDocumentsByFolder(req.params.id, { includeArchived });
  res.json(documents);
});

const addFolderDocument = asyncHandler(async (req, res) => {
  const {
    name,
    file_url,
    upload_id,
    size,
    ext,
    status,
    uploaded_by,
    company_id,
  } = req.body || {};

  if (!name || !size || !ext || !status || !uploaded_by || !company_id) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!permissionService.canAccessCompany(req.user, company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }

  let resolvedUploadId = upload_id || null;
  let resolvedFileUrl = file_url || null;

  if (resolvedUploadId) {
    const isValid = await documentService.validateUpload(resolvedUploadId);
    if (!isValid) {
      return res.status(400).json({ error: "upload_id is invalid" });
    }
    resolvedFileUrl = resolvedFileUrl || buildUploadContentUrl(req, resolvedUploadId);
  }

  if (!resolvedFileUrl) {
    return res.status(400).json({ error: "file_url or upload_id required" });
  }

  let targetFolderId = req.params.id;
  if (targetFolderId === "root") {
    const uploadFolder = await folderService.ensureRootUploadFolder(company_id, uploaded_by || req.user?.id || null);
    if (!uploadFolder?.id) {
      return res.status(400).json({ error: "Unable to resolve a destination folder for root uploads" });
    }
    targetFolderId = uploadFolder.id;
  } else {
    const folder = await folderService.getFolderById(targetFolderId);
    if (!folder) return res.status(404).json({ error: "Folder not found" });
    if (String(folder.company_id) !== String(company_id)) {
      return res.status(400).json({ error: "Folder does not belong to this company" });
    }
  }

  const doc = await documentService.createDocument({
    company_id,
    folder_id: targetFolderId,
    name,
    file_url: resolvedFileUrl,
    upload_id: resolvedUploadId,
    size,
    ext,
    status,
    uploaded_by
  });

  // Resolve the uploader's display name (name + role label) for the immediate response
  // so the front-end never has to show a raw UUID.
  let uploaded_by_name = null;
  try {
    const { supabase } = require("../db");
    const uploaderUser = req.user?.id === uploaded_by ? req.user : null;
    if (uploaderUser && (uploaderUser.name || uploaderUser.email)) {
      const role = uploaderUser.role || "";
      const label = role === "broker" || role === "admin" ? "Broker"
        : role === "client" ? "Client"
        : role === "user" ? "Buyer"
        : role === "provider" ? "Provider" : null;
      const displayName = uploaderUser.name || uploaderUser.email || "User";
      uploaded_by_name = label ? `${displayName} (${label})` : displayName;
    } else if (uploaded_by) {
      const { data: u } = await supabase.from("users").select("name, email, role").eq("id", uploaded_by).maybeSingle();
      if (u) {
        const label = u.role === "broker" || u.role === "admin" ? "Broker"
          : u.role === "client" ? "Client"
          : u.role === "user" ? "Buyer"
          : u.role === "provider" ? "Provider" : null;
        const displayName = u.name || u.email || "User";
        uploaded_by_name = label ? `${displayName} (${label})` : displayName;
      }
    }
  } catch (_) { /* non-fatal — front-end will fall back */ }

  res.status(201).json({
    ...doc,
    uploaded_by_name,
    folder_name: targetFolderId === req.params.id ? null : "General Uploads",
  });
});

const archiveFolderController = asyncHandler(async (req, res) => {
  const existing = await folderService.getFolderById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const folder = await folderService.archiveFolder(req.params.id);
  res.json(folder);
});

const unarchiveFolderController = asyncHandler(async (req, res) => {
  const existing = await folderService.getFolderById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const folder = await folderService.unarchiveFolder(req.params.id);
  res.json(folder);
});

const archiveDocumentController = asyncHandler(async (req, res) => {
  const existing = await documentService.getDocumentById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const document = await documentService.archiveDocument(req.params.id);
  res.json(document);
});

const unarchiveDocumentController = asyncHandler(async (req, res) => {
  const existing = await documentService.getDocumentById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const document = await documentService.unarchiveDocument(req.params.id);
  res.json(document);
});

const deleteDocument = asyncHandler(async (req, res) => {
  const existing = await documentService.getDocumentById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (!permissionService.canAccessCompany(req.user, existing.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  await documentService.deleteDocument(req.params.id);
  res.status(204).send();
});

const recordDocumentActivity = asyncHandler(async (req, res) => {
  const { activity_type } = req.body;
  if (!activity_type || !['view', 'download'].includes(activity_type)) {
    return res.status(400).json({ error: "Invalid activity_type. Must be 'view' or 'download'" });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify the document exists; no company-access check here — any authenticated user who
  // obtained this document ID through the UI has already passed folder-access controls.
  const document = await documentService.getDocumentById(req.params.id);
  if (!document) return res.status(404).json({ error: "Not found" });

  const activity = await documentService.recordDocumentActivity(req.params.id, userId, activity_type);
  res.status(201).json(activity);
});

const getDocumentActivity = asyncHandler(async (req, res) => {
  const document = await documentService.getDocumentById(req.params.id);
  if (!document) return res.status(404).json({ error: "Not found" });
  // Brokers/admins always have access; other roles must be assigned to the company.
  const isBrokerOrAdmin = permissionService.isBroker(req.user);
  if (!isBrokerOrAdmin && !permissionService.canAccessCompany(req.user, document.company_id)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const activity = await documentService.getDocumentActivity(req.params.id);
  res.json(activity);
});

const ensureDefaultFolders = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  if (!permissionService.canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "You do not have permission to access this company's folders." });
  }
  const userId = req.user?.id || null;
  await folderService.ensureCompanyDefaultFolders(companyId, userId);
  res.json({ success: true });
});

module.exports = {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder,
  archiveFolderController,
  unarchiveFolderController,
  listFolderDocuments,
  addFolderDocument,
  deleteDocument,
  archiveDocumentController,
  unarchiveDocumentController,
  listFolderTree,
  recordDocumentActivity,
  getDocumentActivity,
  ensureDefaultFolders,
};
