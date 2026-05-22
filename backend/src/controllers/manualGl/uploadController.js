const { resolveClientId } = require("./clientContext");
const { stageManualReportUpload } = require("../../services/manualReportStagingService");

function toHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function uploadController(req, res) {
  const clientId = resolveClientId(req);
  if (!clientId) {
    throw toHttpError("Missing clientId.", 400);
  }

  const { uploadId, fileName, fileUrl } = req.body || {};
  if (!uploadId) {
    throw toHttpError("uploadId is required.", 400);
  }

  let staged;
  try {
    staged = await stageManualReportUpload({
      companyId: clientId,
      uploadId,
      fileName,
      fileUrl,
      uploadedBy: req.user?.id || null,
    });
  } catch (error) {
    if (!error.status) {
      const isSystemError = /failed to stage upload|upload read failed/i.test(String(error.message || ""));
      error.status = isSystemError ? 500 : 400;
    }
    throw error;
  }

  return res.status(201).json({
    success: true,
    ...staged,
  });
}

module.exports = {
  uploadController,
};
