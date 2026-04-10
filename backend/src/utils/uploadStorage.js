function buildAppBaseUrl(req) {
  const configured = process.env.APP_BASE_URL;
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  return `${req.protocol}://${req.get("host")}`;
}

function buildUploadContentUrl(req, uploadId) {
  return `${buildAppBaseUrl(req)}/uploads/${uploadId}/content`;
}

module.exports = {
  buildAppBaseUrl,
  buildUploadContentUrl,
};
