const folderService = require("../services/folderService");
const documentService = require("../services/documentService");
const asyncHandler = require("../utils");
const { buildUploadContentUrl } = require("../utils/uploadStorage");

const listFolders = asyncHandler(async (req, res) => {
  const folders = await folderService.listFoldersByCompany(req.params.id);
  res.json(folders);
});

const listFolderTree = asyncHandler(async (req, res) => {
  const tree = await folderService.getFolderTree(req.params.id);
  res.json(tree);
});

const createFolder = asyncHandler(async (req, res) => {
  const folder = await folderService.createFolder(req.params.id, req.body);
  res.status(201).json(folder);
});

const updateFolder = asyncHandler(async (req, res) => {
  const folder = await folderService.updateFolder(req.params.id, req.body);
  res.json(folder);
});

const deleteFolder = asyncHandler(async (req, res) => {
  await folderService.deleteFolder(req.params.id);
  res.status(204).send();
});

const moveFolder = asyncHandler(async (req, res) => {
  const folder = await folderService.moveFolder(req.params.id, req.body.parent_id);
  res.json(folder);
});

const listFolderDocuments = asyncHandler(async (req, res) => {
  const documents = await documentService.listDocumentsByFolder(req.params.id);
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

  res.status(201).json({
    ...doc,
    folder_name: targetFolderId === req.params.id ? null : "General Uploads",
  });
});

const deleteDocument = asyncHandler(async (req, res) => {
  await documentService.deleteDocument(req.params.id);
  res.status(204).send();
});

module.exports = {
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder,
  listFolderDocuments,
  addFolderDocument,
  deleteDocument,
  listFolderTree,
};

