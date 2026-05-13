const { processManualGlData } = require("./manualGlService");

async function processGL({ companyId, stagedDataId, mapping = {} }) {
  if (!companyId) throw new Error("companyId is required");
  if (!stagedDataId) throw new Error("stagedDataId is required");

  return processManualGlData({
    companyId,
    uploadId: stagedDataId,
    mapping,
  });
}

module.exports = {
  processGL,
};
