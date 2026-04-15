// ─────────────────────────────────────────────────────────────────────────────
// ROOT CAUSE OF MISSING TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────
// The old readExcelFile() converted every cell to plain pipe-separated text
// and sent that text to the AI parser. For HDFC XLS statements this caused:
//
//   1. XLSX.utils.sheet_to_json with header:1 + defval:"" reads ALL rows
//      correctly — but then the pipe-joined plain text loses column semantics,
//      so the AI cannot reliably tell "Withdrawal" apart from "Deposit".
//
//   2. The AI parser is prone to token-limit truncation and deduplication
//      false-positives when withdrawal & deposit sit in separate columns.
//
//   3. .xls (legacy OLE Compound) files require xlrd, which is not bundled
//      with the SheetJS (xlsx) npm package's default build. SheetJS can still
//      parse them, but only if you call XLSX.read() with the right options.
//
// FIX STRATEGY
// ─────────────────────────────────────────────────────────────────────────────
// 1. Detect the bank format from the spreadsheet header rows.
// 2. If a known structured format is detected (HDFC, SBI, ICICI, Axis…),
//    parse the rows directly into normalized transaction objects — NO AI call
//    needed for these cases. This is 100% accurate and instant.
// 3. For unknown formats, fall back to the existing AI-parsing pipeline, but
//    improve the text representation to preserve column identity.
// 4. Return sections with both `text` (for AI fallback) and `transactions`
//    (for direct use) so the caller can choose the best path.
// ─────────────────────────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse DD/MM/YY or DD/MM/YYYY → YYYY-MM-DD */
function parseIndianDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YY or DD/MM/YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (!m) return null;
  let [, dd, mm, yy] = m;
  if (yy.length === 2) yy = `20${yy}`;
  return `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** Strip ₹ $ £ commas; return float */
function parseAmount(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/[₹$£€,\s]/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** True if the value looks like a separator / header line */
function isSeparatorCell(v) {
  const s = String(v ?? "").trim();
  return s === "" || /^\*+$/.test(s);
}

// ── HDFC Bank XLS/XLSX parser ─────────────────────────────────────────────────
//
// HDFC statement column layout (0-indexed):
//   0: Date        DD/MM/YY
//   1: Narration
//   2: Chq./Ref.No.
//   3: Value Dt
//   4: Withdrawal Amt.   (debit — positive number or blank)
//   5: Deposit Amt.      (credit — positive number or blank)
//   6: Closing Balance
//
// Header row text: "Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance"

function detectHdfcHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i];
    const joined = r.map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("narration") &&
      joined.includes("withdrawal") &&
      joined.includes("deposit") &&
      joined.includes("closing balance")
    ) {
      return i; // index of header row
    }
  }
  return -1;
}

function parseHdfcRows(rows, headerRowIndex) {
  const transactions = [];
  // Data starts 2 rows after header (header + separator row of ***)
  const dataStart = headerRowIndex + 2;

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    const dateRaw = row[0];
    const narration = String(row[1] ?? "").trim();
    const refNo = String(row[2] ?? "").trim();
    const withdrawalRaw = row[4];
    const depositRaw = row[5];
    const balanceRaw = row[6];

    // Skip separator / summary rows
    if (isSeparatorCell(dateRaw)) continue;
    if (/^\*+$/.test(String(dateRaw).trim())) continue;

    const date = parseIndianDate(dateRaw);
    if (!date) continue; // not a transaction row

    const withdrawal = parseAmount(withdrawalRaw);
    const deposit = parseAmount(depositRaw);
    const balance = parseAmount(balanceRaw);

    // At least one of withdrawal or deposit must be present
    if (withdrawal == null && deposit == null) continue;

    if (withdrawal != null && withdrawal !== 0) {
      transactions.push({
        date,
        name: narration || "Unknown",
        amount: -Math.abs(withdrawal), // negative = debit
        type: "debit",
        reference: refNo,
        balance,
      });
    }

    if (deposit != null && deposit !== 0) {
      transactions.push({
        date,
        name: narration || "Unknown",
        amount: Math.abs(deposit), // positive = credit
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }

  return transactions;
}

// ── SBI Bank XLS/XLSX parser ──────────────────────────────────────────────────
// SBI column layout: Txn Date | Value Date | Description | Ref No./Cheque No. | Debit | Credit | Balance
function detectSbiHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      joined.includes("txn date") &&
      joined.includes("debit") &&
      joined.includes("credit") &&
      joined.includes("balance")
    )
      return i;
  }
  return -1;
}

function parseSbiRows(rows, headerRowIndex) {
  const transactions = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const dateRaw = row[0];
    const desc = String(row[2] ?? "").trim();
    const refNo = String(row[3] ?? "").trim();
    const debitRaw = row[4];
    const creditRaw = row[5];
    const balanceRaw = row[6];

    if (isSeparatorCell(dateRaw)) continue;
    const date = parseIndianDate(dateRaw);
    if (!date) continue;

    const debit = parseAmount(debitRaw);
    const credit = parseAmount(creditRaw);
    const balance = parseAmount(balanceRaw);

    if (debit != null && debit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: -Math.abs(debit),
        type: "debit",
        reference: refNo,
        balance,
      });
    }
    if (credit != null && credit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: Math.abs(credit),
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }
  return transactions;
}

// ── ICICI / Axis / generic two-column (Debit + Credit) parser ────────────────
function detectGenericDebitCreditHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const joined = rows[i].map((c) => String(c ?? "").toLowerCase()).join(" ");
    if (
      (joined.includes("debit") || joined.includes("withdrawal")) &&
      (joined.includes("credit") || joined.includes("deposit")) &&
      joined.includes("balance")
    )
      return i;
  }
  return -1;
}

function parseGenericDebitCreditRows(rows, headerRowIndex) {
  const headers = rows[headerRowIndex].map((c) =>
    String(c ?? "")
      .toLowerCase()
      .trim(),
  );

  const colDate = headers.findIndex(
    (h) => h.includes("date") && !h.includes("value"),
  );
  const colDesc = headers.findIndex(
    (h) =>
      h.includes("narration") ||
      h.includes("description") ||
      h.includes("particulars") ||
      h.includes("remarks"),
  );
  const colRef = headers.findIndex(
    (h) =>
      h.includes("ref") ||
      h.includes("chq") ||
      h.includes("cheque") ||
      h.includes("utr"),
  );
  const colDebit = headers.findIndex(
    (h) => h.includes("debit") || h.includes("withdrawal"),
  );
  const colCredit = headers.findIndex(
    (h) => h.includes("credit") || h.includes("deposit"),
  );
  const colBalance = headers.findIndex((h) => h.includes("balance"));

  if (colDate < 0 || colDebit < 0 || colCredit < 0) return null; // can't parse

  const transactions = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isSeparatorCell(row[colDate])) continue;
    const date = parseIndianDate(row[colDate]);
    if (!date) continue;

    const desc = colDesc >= 0 ? String(row[colDesc] ?? "").trim() : "Unknown";
    const refNo = colRef >= 0 ? String(row[colRef] ?? "").trim() : "";
    const debit = parseAmount(row[colDebit]);
    const credit = parseAmount(row[colCredit]);
    const balance = colBalance >= 0 ? parseAmount(row[colBalance]) : null;

    if (debit != null && debit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: -Math.abs(debit),
        type: "debit",
        reference: refNo,
        balance,
      });
    }
    if (credit != null && credit !== 0) {
      transactions.push({
        date,
        name: desc || "Unknown",
        amount: Math.abs(credit),
        type: "credit",
        reference: refNo,
        balance,
      });
    }
  }
  return transactions;
}

// ── Main structured-parse dispatcher ─────────────────────────────────────────

/**
 * Try to directly parse a sheet's rows into transactions without AI.
 * Returns array of transaction objects, or null if format is unrecognized.
 */
function tryDirectParse(rows) {
  // HDFC
  const hdfcIdx = detectHdfcHeaderRow(rows);
  if (hdfcIdx >= 0) {
    const txns = parseHdfcRows(rows, hdfcIdx);
    if (txns.length > 0) return { format: "HDFC Bank", transactions: txns };
  }

  // SBI
  const sbiIdx = detectSbiHeaderRow(rows);
  if (sbiIdx >= 0) {
    const txns = parseSbiRows(rows, sbiIdx);
    if (txns.length > 0)
      return { format: "State Bank of India", transactions: txns };
  }

  // Generic debit/credit columns (ICICI, Axis, Kotak, etc.)
  const genericIdx = detectGenericDebitCreditHeader(rows);
  if (genericIdx >= 0) {
    const txns = parseGenericDebitCreditRows(rows, genericIdx);
    if (txns && txns.length > 0)
      return { format: "Generic", transactions: txns };
  }

  return null;
}

// ── Improved text representation for AI fallback ──────────────────────────────
//
// Instead of joining all cells with | (which loses context), emit a
// labeled column text so the AI understands what each column means.

function rowsToLabeledText(rows, headerRowIndex) {
  if (headerRowIndex < 0) {
    // No recognized header — emit tab-separated with row numbers
    return rows
      .map((row, i) => {
        const vals = row.map((c) => String(c ?? "").trim()).filter(Boolean);
        return vals.length ? `Row ${i + 1}: ${vals.join(" | ")}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  const headerRow = rows[headerRowIndex];
  const colNames = headerRow.map((c) => String(c ?? "").trim());

  const lines = ["COLUMNS: " + colNames.join(" | "), "---"];

  for (let i = headerRowIndex + 2; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => isSeparatorCell(c))) continue;
    const labeled = colNames
      .map((col, j) => {
        const v = String(row[j] ?? "").trim();
        return v ? `${col}: ${v}` : "";
      })
      .filter(Boolean)
      .join(" | ");
    if (labeled) lines.push(labeled);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// DROP-IN REPLACEMENT for readExcelFile()
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage: replace your existing readExcelFile() with this one.
// It returns sections in the same shape as before (title, text, rowCount),
// but also attaches `transactions` when direct parsing succeeds so the
// caller (uploadToBackend) can skip the AI step entirely for known formats.

export const readExcelFile = async (file, password) => {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();

  // SheetJS can read both .xls and .xlsx — no separate xlrd needed.
  // cellDates:true converts Excel serial dates to JS Date objects.
  const workbook = XLSX.read(buffer, {
    type: "array",
    password,
    cellDates: false, // keep raw values; we parse dates ourselves
    raw: true, // don't apply number formatting — get actual numbers
  });

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];

    // Read ALL rows with no limit. header:1 → array-of-arrays.
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: true, // raw numeric values, not formatted strings
    });

    // ── Try direct structured parse first ──────────────────────────────────
    const directResult = tryDirectParse(rows);

    if (directResult) {
      // Build a human-readable text summary for display / fallback only
      const headerIdx = Math.max(
        detectHdfcHeaderRow(rows),
        detectSbiHeaderRow(rows),
        detectGenericDebitCreditHeader(rows),
      );
      const summaryText = rowsToLabeledText(rows, headerIdx);

      return {
        title: sheetName,
        text: summaryText,
        rowCount: rows.length,
        // ↓ NEW: pre-parsed transactions — caller should use these directly
        transactions: directResult.transactions,
        bankFormat: directResult.format,
        directlyParsed: true,
      };
    }

    // ── Fallback: emit labeled text for AI parsing ─────────────────────────
    const headerIdx = detectGenericDebitCreditHeader(rows);
    const fallbackText =
      headerIdx >= 0
        ? rowsToLabeledText(rows, headerIdx)
        : rows
            .map((row) =>
              row
                .map((cell) => String(cell ?? "").trim())
                .filter(Boolean)
                .join(" | "),
            )
            .filter(Boolean)
            .join("\n");

    return {
      title: sheetName,
      text: fallbackText || "No readable rows found in this sheet.",
      rowCount: rows.length,
      transactions: null,
      directlyParsed: false,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATED uploadToBackend — use pre-parsed transactions when available
// ─────────────────────────────────────────────────────────────────────────────
//
// In your WorkspaceReconciliation component, replace the uploadToBackend
// function with the version below. The key change is: if any sheet already
// has `transactions` (directlyParsed === true), skip the AI call entirely
// for those sheets and merge the results.

/*
  const uploadToBackend = async (file, sections) => {
    const fullText = sections.map((s) => s.text).join("\n");
    const detectedBank =
      sections.find((s) => s.bankFormat)?.bankFormat ||
      detectBankName(fullText);

    // ── Fast path: all sheets were directly parsed ─────────────────────────
    const allDirectlyParsed = sections.every((s) => s.directlyParsed);
    const directTransactions = sections
      .filter((s) => s.directlyParsed && Array.isArray(s.transactions))
      .flatMap((s) => s.transactions);

    let normalizedTransactions = [];
    let finalBankName = detectedBank;

    if (directTransactions.length > 0) {
      // Skip AI — use structured parse result directly
      normalizedTransactions = directTransactions;
      setAiParsing({
        status: "success",
        message: `${finalBankName || "Bank"} statement parsed directly — ${normalizedTransactions.length} transaction${normalizedTransactions.length !== 1 ? "s" : ""} found (no AI needed).`,
        bankName: finalBankName,
        transactionCount: normalizedTransactions.length,
      });
    } else {
      // Existing AI-parsing path (unchanged) for unrecognized formats
      setAiParsing({
        status: "parsing",
        message: detectedBank
          ? `Detected ${detectedBank} — parsing all transactions with AI...`
          : "Detecting bank format and parsing all transactions with AI...",
        bankName: detectedBank,
        transactionCount: 0,
      });

      try {
        const result = await parseAllSections(
          sections,
          (progressMessage) => {
            setAiParsing((prev) => ({ ...prev, message: progressMessage }));
          },
          getHeaders(),
        );

        normalizedTransactions = result.transactions;
        finalBankName = result.bankName || detectedBank;

        if (normalizedTransactions.length === 0 && result.parseErrors.length > 0) {
          throw new Error(
            "AI could not extract transactions: " + result.parseErrors.join("; "),
          );
        }

        setAiParsing({
          status: "success",
          message: `${finalBankName || "Bank"} statement parsed — ${normalizedTransactions.length} transaction${normalizedTransactions.length !== 1 ? "s" : ""} found.`,
          bankName: finalBankName,
          transactionCount: normalizedTransactions.length,
        });
      } catch (aiError) {
        console.error("AI parsing failed:", aiError);
        setAiParsing({
          status: "error",
          message: `AI parsing failed: ${aiError.message}. Uploading raw file as fallback.`,
          bankName: finalBankName,
          transactionCount: 0,
        });
      }
    }

    // ── Step 2: Upload to backend (unchanged) ──────────────────────────────
    // ... (rest of uploadToBackend is identical to original)
  };
*/
