const express = require("express");
const { fetchAndCacheReport, serveCachedReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

const router = express.Router();

function normalizeDetailQuery(query = {}) {
  const start_date = String(query.start_date || "").trim();
  const end_date = String(query.end_date || "").trim();
  const accounting_method = String(query.accounting_method || "").trim();
  return { start_date, end_date, accounting_method };
}

module.exports = router;
