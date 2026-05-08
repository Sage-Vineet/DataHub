const XLSX = require("xlsx");
const pdfParse = require("pdf-parse");
const { supabase } = require("../db");
const { processBalanceSheet } = require("./balanceSheetService");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");

const MANUAL_REPORT_UPLOAD_SOURCE = "manual_report_upload";
const STATEMENT_TYPES = {
  BALANCE_SHEET: "balance_sheet",
  PROFIT_AND_LOSS: "profit_and_loss",
  CASH_FLOW: "cash_flow",
};

function normalizeUploadBinary(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  if (typeof data === "string") {
    const value = data.trim();
    if (/^\\x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), "hex");
    if (/^0x[0-9a-f]+$/i.test(value)) return Buffer.from(value.slice(2), "hex");
    return Buffer.from(value, "base64");
  }
  return Buffer.from(String(data));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hasCellValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const raw = String(value).trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/[$,\s]/g, "")
    .replace(/\((.*)\)/, "-$1")
    .replace(/^[=]/, "")
    .replace(/\.{2,}/g, "");

  if (!/^[-+]?[\d.]+$/.test(cleaned)) return null;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function firstTextCell(cells = []) {
  for (const cell of cells) {
    const text = String(cell || "").trim();
    if (/[a-z]/i.test(text)) return text;
  }
  return "";
}

function findAmountInCells(cells = []) {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const amount = parseAmount(cells[index]);
    if (amount !== null) return roundMoney(amount);
  }
  return null;
}

function extractRowsFromWorkbook(buffer, fileName = "", contentType = "") {
  let workbook;
  try {
    if (String(fileName).toLowerCase().endsWith(".csv") || String(contentType).toLowerCase().includes("csv")) {
      workbook = XLSX.read(buffer.toString("utf8"), { type: "string" });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch (error) {
    throw new Error(`Unable to parse workbook: ${error.message}`);
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet) throw new Error("No worksheet found.");

  const rawRows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  return rawRows.filter((row) => Array.isArray(row) && row.some(hasCellValue));
}

async function extractPdfLines(buffer) {
  const parsed = await pdfParse(buffer);
  return String(parsed?.text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function detectStatementType({ fileName = "", rows = [], lines = [] }) {
  const haystack = [
    fileName,
    ...rows.slice(0, 80).map((row) => (Array.isArray(row) ? row.join(" ") : "")),
    ...lines.slice(0, 120),
  ]
    .join(" ")
    .toLowerCase();

  const isBalanceSheet =
    haystack.includes("balance sheet") ||
    (haystack.includes("assets") &&
      haystack.includes("liabilities") &&
      haystack.includes("equity"));

  if (
    haystack.includes("cash flow") ||
    haystack.includes("operating activities") ||
    haystack.includes("investing activities") ||
    haystack.includes("financing activities")
  ) {
    return STATEMENT_TYPES.CASH_FLOW;
  }

  if (isBalanceSheet) {
    return STATEMENT_TYPES.BALANCE_SHEET;
  }

  if (
    haystack.includes("profit and loss") ||
    haystack.includes("income statement") ||
    haystack.includes("ordinary income") ||
    haystack.includes("net income")
  ) {
    return STATEMENT_TYPES.PROFIT_AND_LOSS;
  }

  return null;
}

function buildNode(name, amount, type = "data", id = "") {
  return {
    id: id || `${type}-${normalizeSlug(name) || "row"}`,
    name: String(name || "").trim(),
    amount: roundMoney(Number(amount || 0)),
    type,
  };
}

function buildSectionNode(name, children = [], id = "") {
  const normalizedChildren = Array.isArray(children) ? children.filter(Boolean) : [];
  const totalRow = normalizedChildren
    .slice()
    .reverse()
    .find((child) => child.type === "total");
  const computedAmount = totalRow
    ? totalRow.amount
    : roundMoney(
        normalizedChildren
          .filter((child) => child.type !== "total")
          .reduce((sum, child) => sum + Number(child.amount || 0), 0),
      );

  return {
    id: id || `section-${normalizeSlug(name) || "group"}`,
    name,
    amount: computedAmount,
    type: "header",
    children: normalizedChildren.length ? normalizedChildren : undefined,
  };
}

function normalizeSectionName(value = "") {
  return normalizeText(value)
    .replace(/^total for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMetadataLikeLabel(label = "") {
  const normalized = normalizeText(label);
  return (
    normalized.startsWith("as of ") ||
    normalized.includes("accrual basis") ||
    normalized.includes("cash basis") ||
    normalized.includes("gmt") ||
    normalized.includes("am ") ||
    normalized.includes("pm ")
  );
}

function getBalanceSheetSectionLevel(label = "") {
  const normalized = normalizeSectionName(label);
  if (!normalized) return null;

  if (normalized === "assets" || normalized === "liabilities and equity") {
    return 0;
  }

  if (
    normalized === "liabilities" ||
    normalized === "equity" ||
    normalized === "current assets" ||
    normalized === "fixed assets" ||
    normalized === "other assets" ||
    normalized === "current liabilities" ||
    normalized === "long-term liabilities" ||
    normalized === "long term liabilities"
  ) {
    return 1;
  }

  if (
    normalized === "bank accounts" ||
    normalized === "other current assets" ||
    normalized === "credit cards" ||
    normalized === "other current liabilities"
  ) {
    return 2;
  }

  return null;
}

function matchBalanceSheetSectionStack(stack = [], totalLabel = "") {
  const normalizedTotal = normalizeSectionName(totalLabel);
  if (!normalizedTotal) return stack.length ? stack.length - 1 : -1;

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const sectionName = normalizeSectionName(stack[index]?.name || "");
    if (
      sectionName === normalizedTotal ||
      normalizedTotal.includes(sectionName) ||
      sectionName.includes(normalizedTotal)
    ) {
      return index;
    }
  }

  return stack.length ? stack.length - 1 : -1;
}

function finalizeBalanceSheetSections(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => {
    if (!node?.children) return node;
    return buildSectionNode(
      node.name,
      finalizeBalanceSheetSections(node.children),
      node.id,
    );
  });
}

function parseBalanceSheetHierarchy(entries = []) {
  const roots = [];
  const stack = [];

  const appendToCurrent = (node) => {
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
      return;
    }
    roots.push(node);
  };

  entries.forEach((entry) => {
    const label = String(entry?.label || "").trim();
    if (!label || isMetadataLikeLabel(label)) return;

    const amount = entry?.amount;
    const isTotal = normalizeText(label).startsWith("total ");

    if (amount === null) {
      const level = getBalanceSheetSectionLevel(label);
      if (level === null) return;

      while (stack.length > level) {
        stack.pop();
      }

      const sectionNode = {
        id: `section-${normalizeSlug(label) || entry.index || "group"}`,
        name: label,
        children: [],
      };
      appendToCurrent(sectionNode);
      stack.push(sectionNode);
      return;
    }

    if (isTotal) {
      const matchedIndex = matchBalanceSheetSectionStack(stack, label);
      while (stack.length - 1 > matchedIndex) {
        stack.pop();
      }

      const totalNode = buildNode(
        label,
        amount,
        "total",
        `total-${normalizeSlug(label) || entry.index || "row"}`,
      );
      appendToCurrent(totalNode);

      if (matchedIndex >= 0) {
        stack.splice(matchedIndex);
      }
      return;
    }

    appendToCurrent(
      buildNode(
        label,
        amount,
        "data",
        `${normalizeSlug(label) || "row"}-${entry.index + 1}`,
      ),
    );
  });

  return finalizeBalanceSheetSections(roots);
}

function extractEntriesFromRows(rows = []) {
  return rows
    .map((row, index) => ({
      label: firstTextCell(Array.isArray(row) ? row : []),
      amount: findAmountInCells(Array.isArray(row) ? row : []),
      index,
    }))
    .filter((entry) => entry.label);
}

function extractEntriesFromLines(lines = []) {
  return lines
    .map((line, index) => {
      const match = String(line).match(/^(.*?)(?:\s{2,}|\.{2,}|\t+)\(?[-$0-9,.\s]+\)?$/);
      const label = match?.[1]?.trim() || String(line).replace(/\(?[-$0-9,.\s]+\)?$/, "").trim();
      const amountMatch = String(line).match(/(\(?[-$]?\d[\d,]*(?:\.\d+)?\)?)\s*$/);
      return {
        label,
        amount: amountMatch ? roundMoney(parseAmount(amountMatch[1]) || 0) : null,
        index,
      };
    })
    .filter((entry) => entry.label);
}

function normalizeSectionLabel(value = "") {
  return normalizeText(value)
    .replace(/^total for\s+/, "")
    .replace(/^total\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSectionedStatement(entries = [], sectionDefinitions = [], options = {}) {
  const rows = [];
  let currentSection = null;
  const exactMatchOnly = options.exactMatchOnly !== false;

  const findSection = (label = "") => {
    const normalized = normalizeSectionLabel(label);
    return sectionDefinitions.find((section) =>
      section.matches.some((keyword) => {
        const normalizedKeyword = normalizeSectionLabel(keyword);
        return exactMatchOnly
          ? normalized === normalizedKeyword
          : normalized.includes(normalizedKeyword);
      }),
    );
  };

  entries.forEach((entry) => {
    const section = findSection(entry.label);
    if (section && entry.amount === null) {
      currentSection = {
        name: section.name,
        id: section.id,
        children: [],
      };
      rows.push(currentSection);
      return;
    }

    if (entry.amount === null) return;

    const target = currentSection?.children ? currentSection.children : rows;
    const normalizedLabel = normalizeText(entry.label);
    const type =
      normalizedLabel.includes("total ") ||
      normalizedLabel.includes("net income") ||
      normalizedLabel.includes("gross profit") ||
      normalizedLabel.includes("net cash") ||
      normalizedLabel.includes("ending cash") ||
      normalizedLabel.includes("ending balance")
        ? "total"
        : "data";

    target.push(
      buildNode(
        entry.label,
        entry.amount,
        type,
        `${normalizeSlug(entry.label) || "row"}-${entry.index + 1}`,
      ),
    );
  });

  return rows.map((row) =>
    row?.children ? buildSectionNode(row.name, row.children, row.id) : row,
  );
}

async function parseStoredReport(upload) {
  const buffer = normalizeUploadBinary(upload?.data);
  const fileName = String(upload?.file_name || "");
  const contentType = String(upload?.content_type || "");
  const lowerFileName = fileName.toLowerCase();

  let rows = [];
  let lines = [];
  let parserType = "excel";

  if (lowerFileName.endsWith(".pdf") || contentType.toLowerCase().includes("pdf")) {
    parserType = "pdf";
    lines = await extractPdfLines(buffer);
  } else {
    rows = extractRowsFromWorkbook(buffer, fileName, contentType);
  }

  const statementType = detectStatementType({ fileName, rows, lines });
  if (!statementType) return null;

  if (statementType === STATEMENT_TYPES.BALANCE_SHEET) {
    let structured = { asOfDate: null };
    try {
      structured = rows.length
        ? processBalanceSheet({ rawRows: rows })
        : processBalanceSheet({
            rawRows: lines.map((line) => [line]),
          });
    } catch (error) {
      console.warn(
        `[ManualReportUpload] Balance Sheet normalization fallback engaged for ${fileName}: ${error.message}`,
      );
    }
    const entries = rows.length ? extractEntriesFromRows(rows) : extractEntriesFromLines(lines);
    const hierarchyRows = parseBalanceSheetHierarchy(entries);

    return {
      statementType,
      parserType,
      report: {
        rows: hierarchyRows.length ? hierarchyRows : [],
        asOfDate: structured.asOfDate || null,
      },
    };
  }

  const entries = rows.length ? extractEntriesFromRows(rows) : extractEntriesFromLines(lines);
  const sectionDefinitions =
    statementType === STATEMENT_TYPES.PROFIT_AND_LOSS
      ? [
          {
            id: "income",
            name: "Income",
            matches: ["income", "revenue", "ordinary income", "ordinary income/expense"],
          },
          {
            id: "cost-of-sales",
            name: "Cost of Sales",
            matches: ["cost of goods sold", "cost of sales", "cost of goods sold/cost of sales"],
          },
          {
            id: "expenses",
            name: "Expenses",
            matches: ["expenses", "expense", "operating expenses"],
          },
          {
            id: "other-income",
            name: "Other Income / Expense",
            matches: ["other income", "other expense", "other income / expense", "other income expense", "net other income"],
          },
        ]
      : [
          { id: "operating", name: "Operating Activities", matches: ["operating activities"] },
          { id: "investing", name: "Investing Activities", matches: ["investing activities"] },
          { id: "financing", name: "Financing Activities", matches: ["financing activities"] },
        ];

  return {
    statementType,
    parserType,
    report: {
      rows: parseSectionedStatement(
        entries,
        sectionDefinitions,
        { exactMatchOnly: statementType === STATEMENT_TYPES.PROFIT_AND_LOSS },
      ),
    },
  };
}

async function loadUpload(uploadId) {
  const { data: upload, error } = await supabase
    .from("uploads")
    .select("id, file_name, content_type, data")
    .eq("id", uploadId)
    .maybeSingle();

  if (error) throw new Error(`Upload read failed: ${error.message}`);
  if (!upload) throw new Error("Upload not found.");
  return upload;
}

async function syncManualReportFolder({ companyId, folderId, folderName = "" }) {
  if (!companyId) throw new Error("companyId is required");
  if (!folderId) throw new Error("folderId is required");

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, name, upload_id, file_url")
    .eq("folder_id", folderId)
    .not("upload_id", "is", null)
    .order("uploaded_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load folder documents: ${error.message}`);
  }

  const processed = [];
  const skipped = [];
  const now = new Date().toISOString();

  for (const document of documents || []) {
    try {
      const upload = await loadUpload(document.upload_id);
      const parsed = await parseStoredReport(upload);
      if (!parsed?.statementType || !parsed?.report?.rows?.length) {
        skipped.push({
          documentId: document.id,
          fileName: document.name,
          reason: "Unsupported or unreadable report",
        });
        continue;
      }

      const { error: upsertError } = await supabase
        .from("qb_synced_reports")
        .upsert(
          {
            company_id: companyId,
            report_type: parsed.statementType,
            report_params: {
              folderId,
              folderName,
              documentId: document.id,
              uploadId: document.upload_id,
              fileName: document.name,
            },
            data: {
              manual_report_upload: {
                statementType: parsed.statementType,
                parserType: parsed.parserType,
                folderId,
                folderName,
                documentId: document.id,
                uploadId: document.upload_id,
                fileName: document.name,
                fileUrl: document.file_url || null,
                report: parsed.report,
                syncedAt: now,
              },
            },
            source: MANUAL_REPORT_UPLOAD_SOURCE,
            status: "synced",
            last_synced_at: now,
            updated_at: now,
          },
          { onConflict: "company_id,report_type,report_params" },
        );

      if (upsertError) {
        throw new Error(upsertError.message);
      }

      processed.push({
        documentId: document.id,
        fileName: document.name,
        statementType: parsed.statementType,
      });
    } catch (syncError) {
      skipped.push({
        documentId: document.id,
        fileName: document.name,
        reason: syncError.message,
      });
    }
  }

  try {
    await updateReportSourceRecord(companyId, REPORT_SOURCE_KEYS.MANUAL_UPLOAD, {
      isAvailable: processed.length > 0,
      isConnected: false,
      lastSyncedAt: processed.length > 0 ? now : null,
      metadata: {
        selectedFolderId: folderId,
        selectedFolderName: folderName || null,
        syncedReportTypes: Array.from(new Set(processed.map((item) => item.statementType))),
        processedCount: processed.length,
        skippedCount: skipped.length,
      },
    });
  } catch (updateError) {
    console.warn("[ManualReportUpload] Failed to update source record:", updateError.message);
  }

  return {
    folderId,
    folderName,
    processed,
    skipped,
    processedCount: processed.length,
  };
}

async function getLatestManualUploadedReport({ companyId, statementType }) {
  if (!companyId) throw new Error("companyId is required");
  if (!statementType) throw new Error("statementType is required");

  const { data, error } = await supabase
    .from("qb_synced_reports")
    .select("id, report_type, report_params, data, updated_at, last_synced_at")
    .eq("company_id", companyId)
    .eq("source", MANUAL_REPORT_UPLOAD_SOURCE)
    .eq("report_type", statementType)
    .order("updated_at", { ascending: false })
    .order("last_synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Manual uploaded report fetch failed: ${error.message}`);
  }

  return data || null;
}

module.exports = {
  MANUAL_REPORT_UPLOAD_SOURCE,
  STATEMENT_TYPES,
  syncManualReportFolder,
  getLatestManualUploadedReport,
};
