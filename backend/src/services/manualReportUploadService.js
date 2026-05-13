const path = require("path");
const { Worker } = require("worker_threads");
const XLSX = require("xlsx");
const { supabase } = require("../db");
const { processBalanceSheet } = require("./balanceSheetService");
const {
  REPORT_SOURCE_KEYS,
  updateReportSourceRecord,
} = require("./reportSourceStore");
const { parsePdfWithGemini } = require("./geminiFinancialParser");

const PDF_WORKER_PATH = path.join(__dirname, "../workers/pdfParser.js");
const PDF_PARSE_TIMEOUT_MS = 30000;

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

const MONTH_INDEX = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function toIsoDate(dateStr = "") {
  if (!dateStr) return null;
  const s = String(dateStr).trim().replace(/,/g, "");

  // "March 31 2025" / "Jan 1 2025"
  const longMatch = s.match(/^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/i);
  if (longMatch) {
    const month = MONTH_INDEX[longMatch[1].toLowerCase()];
    if (month !== undefined) {
      return `${longMatch[3]}-${String(month + 1).padStart(2, "0")}-${String(parseInt(longMatch[2], 10)).padStart(2, "0")}`;
    }
  }

  // "January 2023" — month + year only
  const monthYearMatch = s.match(/^([a-z]+)\s+(\d{4})$/i);
  if (monthYearMatch) {
    const month = MONTH_INDEX[monthYearMatch[1].toLowerCase()];
    if (month !== undefined) {
      return `${monthYearMatch[2]}-${String(month + 1).padStart(2, "0")}-01`;
    }
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const numericMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (numericMatch) {
    let year = parseInt(numericMatch[3], 10);
    if (year < 100) year += 2000;
    return `${year}-${String(parseInt(numericMatch[1], 10)).padStart(2, "0")}-${String(parseInt(numericMatch[2], 10)).padStart(2, "0")}`;
  }

  // YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(parseInt(isoMatch[2], 10)).padStart(2, "0")}-${String(parseInt(isoMatch[3], 10)).padStart(2, "0")}`;
  }

  return null;
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

function extractPdfLines(buffer) {
  return new Promise((resolve, reject) => {
    // Copy the buffer into a fresh ArrayBuffer so it can be safely transferred
    // to the worker thread without sharing memory with the main thread pool.
    const owned = Buffer.from(buffer);
    const arrayBuffer = owned.buffer.slice(
      owned.byteOffset,
      owned.byteOffset + owned.byteLength,
    );

    const worker = new Worker(PDF_WORKER_PATH, {
      workerData: { arrayBuffer },
      transferList: [arrayBuffer],
    });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("PDF parsing timed out"));
    }, PDF_PARSE_TIMEOUT_MS);

    const cleanup = () => clearTimeout(timer);

    worker.once("message", (msg) => {
      cleanup();
      if (msg.success) {
        resolve(
          String(msg.text)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        );
      } else {
        reject(new Error(msg.error || "PDF parsing failed"));
      }
    });

    worker.once("error", (err) => {
      cleanup();
      reject(err);
    });

    worker.once("exit", (code) => {
      cleanup();
      if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`));
    });
  });
}

function isStandaloneYear(str = "") {
  return /^\d{4}$/.test(String(str).replace(/[$,()]/g, "").trim());
}

function isPageIndicatorLine(line = "") {
  const s = String(line).trim().toLowerCase();
  return /^page\s+\d+(\s+of\s+\d+)?$/.test(s) || /^\d+$/.test(s);
}

function extractAsOfDateFromLines(lines = []) {
  const asOfPattern = /as\s+of\s+([a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i;
  for (const line of lines.slice(0, 40)) {
    const match = line.match(asOfPattern);
    if (match?.[1]) {
      const date = toIsoDate(match[1].trim());
      if (date) return date;
    }
  }
  const monthPattern = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i;
  for (const line of lines.slice(0, 40)) {
    const match = line.match(monthPattern);
    if (match) {
      const date = toIsoDate(match[0]);
      if (date) return date;
    }
  }
  return null;
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
    haystack.includes("profit & loss") ||
    haystack.includes("income statement") ||
    haystack.includes("ordinary income") ||
    haystack.includes("net income")
  ) {
    return STATEMENT_TYPES.PROFIT_AND_LOSS;
  }

  return null;
}

function buildNode(name, amount, type = "data", id = "", firstPeriodAmount = null) {
  const node = {
    id: id || `${type}-${normalizeSlug(name) || "row"}`,
    name: String(name || "").trim(),
    amount: roundMoney(Number(amount || 0)),
    type,
  };
  if (firstPeriodAmount !== null && firstPeriodAmount !== undefined) {
    node.firstPeriodAmount = roundMoney(Number(firstPeriodAmount));
  }
  return node;
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
    normalized.includes("pm ") ||
    /\bthrough\b/.test(normalized) ||
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(normalized) ||
    /^page\s+\d+/.test(normalized)
  );
}

function getBalanceSheetSectionLevel(label = "") {
  const normalized = normalizeSectionName(label);
  if (!normalized) return null;

  if (
    normalized === "assets" ||
    normalized === "liabilities and equity" ||
    normalized === "liabilities & equity"
  ) {
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
  if (!normalizedTotal) return -1;

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const sectionName = normalizeSectionName(stack[index]?.name || "");
    // Only match exact equality OR the section name is a substring of the total label
    // (e.g. "bank accounts" inside "total bank accounts" → normalizedTotal.includes(sectionName)).
    // Do NOT match the reverse (sectionName.includes(normalizedTotal)) because that causes
    // "liabilities & equity" to match "total liabilities", wiping the root from the stack.
    if (sectionName === normalizedTotal || normalizedTotal.includes(sectionName)) {
      return index;
    }
  }

  return -1;
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

      // Only pop deeper sections when we have an actual match.
      // If matchedIndex is -1 (unrecognised total such as "TOTAL LIABILITIES" when
      // only "LIABILITIES & EQUITY" is on the stack), we leave the stack as-is so
      // subsequent siblings (e.g. Equity) still nest under the right parent.
      if (matchedIndex >= 0) {
        while (stack.length - 1 > matchedIndex) {
          stack.pop();
        }
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
  const entries = [];
  let i = 0;

  while (i < lines.length) {
    const line = String(lines[i]).trim();

    if (!line || isPageIndicatorLine(line)) {
      i++;
      continue;
    }

    // Pattern 0: Multi-column line — 2+ dollar-prefixed amounts on the same line.
    // e.g. "Revenue  $1,000  $1,200  ...  $15,000"
    //      "Discounts  $383.88  $479.11  ...  $-22,266.07"
    // Label = text before the first $, firstPeriodAmount = first $ value, amount = last $ value.
    const dollarMatches = [...line.matchAll(/\$-?\d[\d,]*(?:\.\d+)?/g)];
    if (dollarMatches.length >= 2) {
      const firstDollarIdx = dollarMatches[0].index;
      const potentialLabel = line.slice(0, firstDollarIdx).replace(/[\s.\-_]+$/, "").trim();
      if (potentialLabel) {
        const firstPeriodAmount = roundMoney(parseAmount(dollarMatches[0][0]) || 0);
        const totalAmount = roundMoney(parseAmount(dollarMatches[dollarMatches.length - 1][0]) || 0);
        entries.push({ label: potentialLabel, amount: totalAmount, firstPeriodAmount, index: i });
        i++;
        continue;
      }
    }

    // Pattern 1: label and amount on the same line.
    // Handles: "Checking  12,345.00"  "Revenue  (5,000.00)"  "Retained Earnings  $-116,747.37"  "Account  -"
    const inlineMatch = line.match(/^(.*)\s+(\$-?\d[\d,]*(?:\.\d+)?|\(?-?\$?\d[\d,]*(?:\.\d+)?\)?|-)\s*$/);
    if (inlineMatch) {
      const potentialLabel = inlineMatch[1].replace(/[\s.\-_]+$/, "").trim();
      const amountStr = inlineMatch[2];

      if (potentialLabel && !isStandaloneYear(amountStr)) {
        const parsedAmt = amountStr === "-" ? 0 : (parseAmount(amountStr) || 0);
        entries.push({ label: potentialLabel, amount: roundMoney(parsedAmt), index: i });
        i++;
        continue;
      }
    }

    // Pattern 2: label on this line, standalone amount on the very next line.
    // Handles PDFs where label and value appear on alternating lines.
    if (i + 1 < lines.length) {
      const nextLine = String(lines[i + 1]).trim();
      const isNextAmount =
        (/^\$?-?\d[\d,]*(?:\.\d+)?$/.test(nextLine) || /^\(-?\d[\d,]*(?:\.\d+)?\)$/.test(nextLine) || nextLine === "-") &&
        !isPageIndicatorLine(nextLine) &&
        !isStandaloneYear(nextLine);

      if (isNextAmount) {
        const parsedAmt = nextLine === "-" ? 0 : (parseAmount(nextLine) || 0);
        entries.push({ label: line, amount: roundMoney(parsedAmt), index: i });
        i += 2;
        continue;
      }
    }

    // No amount found — section header or metadata line.
    entries.push({ label: line, amount: null, index: i });
    i++;
  }

  return entries.filter((entry) => entry.label);
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
        entry.firstPeriodAmount ?? null,
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
  const isPdf = lowerFileName.endsWith(".pdf") || contentType.toLowerCase().includes("pdf");

  // ── Gemini path for PDFs ────────────────────────────────────────────────
  if (isPdf && process.env.GEMINI_API_KEY) {
    try {
      const geminiResult = await parsePdfWithGemini(buffer, fileName);
      if (geminiResult?.statementType && Array.isArray(geminiResult.rows) && geminiResult.rows.length > 0) {
        console.log(`[ManualReportUpload] Gemini parsed "${fileName}" as ${geminiResult.statementType} (${geminiResult.rows.length} top-level rows)`);
        return {
          statementType: geminiResult.statementType,
          parserType: "gemini",
          report: {
            rows: geminiResult.rows,
            asOfDate: geminiResult.asOfDate || null,
          },
        };
      }
    } catch (geminiError) {
      console.warn(`[ManualReportUpload] Gemini failed for "${fileName}", falling back to text extraction: ${geminiError.message}`);
    }
  }

  // ── Text-extraction fallback (Excel / non-Gemini PDF) ──────────────────
  let rows = [];
  let lines = [];
  let parserType = "excel";

  if (isPdf) {
    parserType = "pdf";
    lines = await extractPdfLines(buffer);
    console.log(`[ManualReportUpload] PDF text fallback "${fileName}" → ${lines.length} lines`);
    if (lines.length > 0) console.log(`[ManualReportUpload] First 10 lines:`, lines.slice(0, 10));
  } else {
    rows = extractRowsFromWorkbook(buffer, fileName, contentType);
  }

  const statementType = detectStatementType({ fileName, rows, lines });
  console.log(`[ManualReportUpload] "${fileName}" detected as: ${statementType || "unknown"}`);
  if (!statementType) return null;

  if (statementType === STATEMENT_TYPES.BALANCE_SHEET) {
    let asOfDate = null;

    if (parserType === "pdf") {
      asOfDate = extractAsOfDateFromLines(lines);
    } else {
      try {
        const structured = processBalanceSheet({ rawRows: rows });
        asOfDate = structured.asOfDate || null;
      } catch (error) {
        console.warn(
          `[ManualReportUpload] Balance Sheet normalization fallback for ${fileName}: ${error.message}`,
        );
      }
    }

    const entries = rows.length ? extractEntriesFromRows(rows) : extractEntriesFromLines(lines);
    const hierarchyRows = parseBalanceSheetHierarchy(entries);

    return {
      statementType,
      parserType,
      report: {
        rows: hierarchyRows.length ? hierarchyRows : [],
        asOfDate,
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

  const exactMatchOnly = parserType !== "pdf" && statementType === STATEMENT_TYPES.PROFIT_AND_LOSS;

  return {
    statementType,
    parserType,
    report: {
      rows: parseSectionedStatement(entries, sectionDefinitions, { exactMatchOnly }),
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

  // Process all documents in parallel — each PDF spins up its own worker thread
  // so the main event loop stays free and multiple files don't queue behind each other.
  const settlements = await Promise.allSettled(
    (documents || []).map(async (document) => {
      const upload = await loadUpload(document.upload_id);
      const parsed = await parseStoredReport(upload);

      if (!parsed?.statementType || !parsed?.report?.rows?.length) {
        return { skipped: true, documentId: document.id, fileName: document.name, reason: "Unsupported or unreadable report" };
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

      if (upsertError) throw new Error(upsertError.message);

      return { skipped: false, documentId: document.id, fileName: document.name, statementType: parsed.statementType };
    }),
  );

  for (let idx = 0; idx < settlements.length; idx++) {
    const doc = (documents || [])[idx];
    const settlement = settlements[idx];
    if (settlement.status === "fulfilled") {
      const val = settlement.value;
      if (val.skipped) {
        skipped.push({ documentId: val.documentId, fileName: val.fileName, reason: val.reason });
      } else {
        processed.push({ documentId: val.documentId, fileName: val.fileName, statementType: val.statementType });
      }
    } else {
      skipped.push({ documentId: doc?.id, fileName: doc?.name, reason: settlement.reason?.message || "Processing failed" });
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
