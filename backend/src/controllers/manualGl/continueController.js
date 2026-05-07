const { resolveClientId } = require("./clientContext");
const { processGL } = require("../../services/glProcessingService");
const {
  REPORT_TYPES,
  getStagedManualReport,
  updateStagedManualReport,
} = require("../../services/manualReportStagingService");
const {
  validateBalanceSheet,
  saveBalanceSheetSnapshot,
} = require("../../services/balanceSheetService");

function toHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function continueController(req, res) {
  const clientId = resolveClientId(req);
  if (!clientId) {
    throw toHttpError("Missing clientId.", 400);
  }

  const {
    reportType,
    stagedDataId,
    mapping = {},
  } = req.body || {};

  if (!stagedDataId) {
    throw toHttpError("stagedDataId is required.", 400);
  }
  if (!reportType) {
    throw toHttpError("reportType is required.", 400);
  }
  if (![REPORT_TYPES.GENERAL_LEDGER, REPORT_TYPES.BALANCE_SHEET].includes(reportType)) {
    throw toHttpError("Invalid reportType. Use GENERAL_LEDGER or BALANCE_SHEET.", 400);
  }

  const stagedRecord = await getStagedManualReport({ companyId: clientId, stagedDataId });
  if (!stagedRecord) {
    throw toHttpError("Staged data not found.", 404);
  }

  const stagedData = stagedRecord.data?.manual_stage || {};
  const resolvedReportType = stagedData.reportType || reportType;
  if (resolvedReportType !== reportType) {
    console.warn("[ManualReport] Continue request report type mismatch", {
      requested: reportType,
      staged: resolvedReportType,
      stagedDataId,
    });
  }

  console.info("[ManualReport] Continue processing", {
    companyId: clientId,
    stagedDataId,
    reportType: resolvedReportType,
  });

  if (resolvedReportType === REPORT_TYPES.GENERAL_LEDGER) {
    let result;
    try {
      result = await processGL({
        companyId: clientId,
        stagedDataId,
        mapping,
      });
    } catch (error) {
      if (!error.status) {
        const message = String(error.message || "");
        const isInputError = /upload not found|unable to parse|no data rows|no worksheet|no valid gl rows/i.test(message);
        error.status = isInputError ? 400 : 500;
      }
      throw error;
    }

    if (!result.success) {
      await updateStagedManualReport({
        companyId: clientId,
        stagedDataId,
        status: "needs_mapping",
        patch: {
          lastContinueResult: {
            success: false,
            errors: result.errors || [],
          },
        },
      });

      return res.status(400).json({
        success: false,
        reportType: REPORT_TYPES.GENERAL_LEDGER,
        stagedDataId,
        ...result,
      });
    }

    await updateStagedManualReport({
      companyId: clientId,
      stagedDataId,
      status: "processed",
      patch: {
        processedAt: new Date().toISOString(),
      },
    });

    return res.json({
      success: true,
      reportType: REPORT_TYPES.GENERAL_LEDGER,
      stagedDataId,
      ...result,
    });
  }

  const balanceSheetData = stagedData.structuredData;
  if (!balanceSheetData) {
    throw toHttpError(
      "Staged Balance Sheet data is missing. Please upload and stage the file again.",
      400
    );
  }

  const validation = validateBalanceSheet(balanceSheetData);
  console.info("[ManualReport] Balance Sheet validation result", {
    companyId: clientId,
    stagedDataId,
    isValid: validation.isValid,
    totals: validation.totals,
    difference: validation.difference,
  });

  if (!validation.isValid) {
    await updateStagedManualReport({
      companyId: clientId,
      stagedDataId,
      status: "invalid",
      patch: {
        validation,
      },
    });

    return res.status(400).json({
      success: false,
      reportType: REPORT_TYPES.BALANCE_SHEET,
      stagedDataId,
      error: validation.message,
      validation,
      data: balanceSheetData,
    });
  }

  const snapshot = await saveBalanceSheetSnapshot({
    companyId: clientId,
    stagedDataId,
    sourceUploadId: stagedData.uploadId || stagedDataId,
    data: balanceSheetData,
    validation,
  });

  await updateStagedManualReport({
    companyId: clientId,
    stagedDataId,
    status: "validated",
    patch: {
      validation,
      snapshotId: snapshot.id,
      validatedAt: new Date().toISOString(),
    },
  });

  return res.json({
    success: true,
    reportType: REPORT_TYPES.BALANCE_SHEET,
    stagedDataId,
    validation,
    snapshotId: snapshot.id,
    data: balanceSheetData,
  });
}

module.exports = {
  continueController,
};
