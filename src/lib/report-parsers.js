function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value?.Row) return asArray(value.Row);
  if (value === undefined || value === null) return [];
  return [value];
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;

  const trimmed = value.trim();
  if (!trimmed) return 0;

  const negativeByParens = trimmed.includes("(") && trimmed.includes(")");
  const numeric = parseFloat(trimmed.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric)) return 0;

  return negativeByParens ? -Math.abs(numeric) : numeric;
}

function extractRows(payload) {
  const candidate =
    payload?.Rows?.Row ||
    payload?.data?.Rows?.Row ||
    payload?.data?.data?.Rows?.Row ||
    payload?.data?.data?.data?.Rows?.Row ||
    [];
  return asArray(candidate);
}

function getChildRows(row) {
  if (!row) return [];
  const candidate = row.Rows?.Row || row.Rows || row.Row || [];
  return asArray(candidate);
}

function getReportDate(payload, fallback = "") {
  return (
    payload?.Header?.EndPeriod ||
    payload?.Header?.StartPeriod ||
    payload?.Header?.Time ||
    fallback ||
    ""
  );
}

function getRowLabel(row, fallback = "") {
  return (
    row?.Header?.ColData?.[0]?.value ||
    row?.Summary?.ColData?.[0]?.value ||
    row?.ColData?.[0]?.value ||
    fallback
  );
}

function findLastNumericValue(columns) {
  const list = Array.isArray(columns) ? columns : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const raw = list[index]?.value;
    if (raw === undefined || raw === null || raw === "") continue;
    const parsed = toNumber(String(raw));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function isTotalLikeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .includes("total");
}

function normalizeKey(value) {
  if (!value) return "";
  let clean = String(value)
    .toLowerCase()
    .replace(/^total\s+/i, "")
    .replace(/^account:\s*/i, "")
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  // Also handle leading account numbers (e.g. "1001 Checking" -> "checking")
  const withoutLeadingNumbers = clean.replace(/^\d+[\s·-]+/, "").trim();

  return withoutLeadingNumbers.replace(/\s+/g, "-");
}

function getAltKeys(value) {
  if (!value) return [];
  const keys = new Set();
  const base = String(value).toLowerCase().trim();

  keys.add(normalizeKey(base));

  // Try without any non-alpha
  keys.add(base.replace(/[^a-z0-9]+/g, ""));

  // If colon-delimited
  if (base.includes(":")) {
    const parts = base.split(":");
    keys.add(normalizeKey(parts[parts.length - 1]));
  }

  return Array.from(keys).filter(Boolean);
}

function isSectionLikeRow(row) {
  if (!row) return false;
  const type = String(row?.type || "").toLowerCase();
  if (type === "section") return true;
  if (type === "data") return false;

  const childRows = getChildRows(row);
  const hasChildren = childRows.length > 0;

  // If it has transactions/column data but NO children, it's a data row, not a section.
  // Sections usually have a Header or Summary object.
  if (row.ColData && !hasChildren && !row.Header && !row.Summary) return false;

  return hasChildren || Boolean(row.Header || row.Summary);
}

function hasReportRows(report) {
  return Boolean(report?.Rows?.Row || report?.data?.Rows?.Row);
}

function pickQuickbooksReport(...candidates) {
  let firstTruthy = null;

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!firstTruthy) firstTruthy = candidate;
    if (candidate?.error) continue;
    if (hasReportRows(candidate)) return candidate;
  }

  return firstTruthy;
}

// --- Summary Rows.Row parser (ported from working project) ---
function parseSummaryRows(rows, indexOffset = 0) {
  const result = [];
  if (!rows || !Array.isArray(rows)) return result;

  let childIndex = indexOffset;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const type = String(row?.type || "").toLowerCase();
    const childRows = getChildRows(row);

    if (
      type === "section" ||
      (childRows.length > 0 &&
        (row?.Header?.ColData?.length ||
          row?.Summary?.ColData?.length ||
          row?.ColData?.length))
    ) {
      const name = getRowLabel(row, "Section");
      const summaryCols = row?.Summary?.ColData || [];
      const totalAmount = summaryCols.length
        ? findLastNumericValue(summaryCols)
        : findLastNumericValue(row?.ColData);

      const children = [];
      if (childRows.length > 0) {
        children.push(...parseSummaryRows(childRows, childIndex));
      }
      childIndex += children.length;

      const cleanName = String(name || "")
        .replace(/^Total\\s+/i, "")
        .replace(/[^a-zA-Z0-9]/g, "-")
        .toLowerCase();
      const sectionId =
        row?.group || row?.id || `section-${cleanName}-${indexOffset + index}`;

      if (row?.Summary && children.length > 0) {
        const summaryName =
          row?.Summary?.ColData?.[0]?.value || `Total ${cleanName}`;
        const lastChild = children[children.length - 1];
        const alreadyHasTotal =
          lastChild &&
          lastChild.type === "total" &&
          String(lastChild.name || "") === String(summaryName || "");

        if (!alreadyHasTotal) {
          children.push({
            id: `total-${cleanName}-${indexOffset + index}`,
            name: summaryName,
            amount: totalAmount,
            type: "total",
          });
        }
      }

      result.push({
        id: sectionId,
        name: cleanName
          .replace(/-/g, " ")
          .replace(/\b\w/g, (letter) => letter.toUpperCase()),
        amount: totalAmount,
        amounts: { y5: totalAmount },
        type: "header",
        children: children.length > 0 ? children : undefined,
      });
      continue;
    }

    if (type === "data" || Array.isArray(row?.ColData)) {
      const name = getRowLabel(row, "Unknown");
      const amount = findLastNumericValue(row?.ColData);
      const raw = String(row?.ColData?.[row?.ColData?.length - 1]?.value || "");
      const normalizedAmount =
        raw.includes("(") && raw.includes(")") ? -Math.abs(amount) : amount;

      const key = String(name || "")
        .replace(/[^a-zA-Z0-9]/g, "-")
        .toLowerCase();

      result.push({
        id:
          row?.ColData?.[0]?.id ||
          row?.id ||
          `data-${key}-${indexOffset + index}`,
        name,
        amount: normalizedAmount,
        amounts: { y5: normalizedAmount },
        type: isTotalLikeLabel(name) ? "total" : "data",
      });
      continue;
    }

    if (Array.isArray(row?.Summary?.ColData)) {
      const name = row?.Summary?.ColData?.[0]?.value || "Total";
      const amount = findLastNumericValue(row.Summary.ColData);
      const key = String(name || "")
        .replace(/[^a-zA-Z0-9]/g, "-")
        .toLowerCase();

      result.push({
        id: row?.id || `summary-${key}-${indexOffset + index}`,
        name,
        amount,
        type: "total",
      });
    }
  }

  return result;
}

// --- Detail Rows.Row parser (ported from working project) ---
function extractTransactions(rowArray, reportDate = "", columnsMetadata = []) {
  const transactions = [];
  const rows = asArray(rowArray);
  if (rows.length === 0) return transactions;

  // Identify column indices from metadata if available
  let amountIdx = -1;
  let balanceIdx = -1;

  if (columnsMetadata && columnsMetadata.length > 0) {
    amountIdx = columnsMetadata.findIndex(
      (c) =>
        c.ColType?.toLowerCase().includes("amount") ||
        c.ColType?.toLowerCase().includes("money") ||
        c.ColTitle?.toLowerCase().includes("amount"),
    );
    balanceIdx = columnsMetadata.findIndex(
      (c) =>
        c.ColType?.toLowerCase().includes("balance") ||
        c.ColTitle?.toLowerCase().includes("balance"),
    );
  }

  // Fallback indices if not found (standard QuickBooks GL structure)
  if (amountIdx === -1) amountIdx = 6;
  if (balanceIdx === -1) balanceIdx = 7;

  rows.forEach((row) => {
    if (!row) return;
    const type = String(row?.type || "").toLowerCase();
    const subRows = getChildRows(row);

    // 1. Handle any row that has column data (likely a transaction)
    if (row.ColData && Array.isArray(row.ColData)) {
      const columns = row.ColData;
      const label = String(columns[0]?.value || "");

      // A transaction row must have some data beside just a total
      if (!isTotalLikeLabel(label) && columns.length >= 2) {
        // Dynamic detection with robust fallbacks
        let amountVal = 0;
        let balanceVal = 0;

        if (amountIdx >= 0 && amountIdx < columns.length) {
          amountVal = toNumber(String(columns[amountIdx].value || "0"));
        } else {
          // Fallback: look for the second to last column which is usually Amount
          amountVal = findLastNumericValue(columns.slice(0, -1));
        }

        if (balanceIdx >= 0 && balanceIdx < columns.length) {
          balanceVal = toNumber(String(columns[balanceIdx].value || "0"));
        } else {
          balanceVal = findLastNumericValue(columns);
        }

        transactions.push({
          id: String(
            columns[0]?.id || row.id || Math.random().toString(36).slice(2, 9),
          ),
          date: label || reportDate,
          type: columns[1]?.value || "Transaction",
          num: columns[2]?.value || "",
          name:
            columns[3]?.value || columns[4]?.value || columns[5]?.value || "",
          memo: columns[4]?.value || "",
          split: columns[5]?.value || "",
          amount: amountVal,
          balance: balanceVal,
        });
      }
    }

    // 2. Always recurse into children to find more transactions
    if (subRows.length > 0) {
      transactions.push(
        ...extractTransactions(subRows, reportDate, columnsMetadata),
      );
    }
  });

  return transactions;
}

function findAccounts(rows, reportDate, columnsMetadata = []) {
  const accounts = [];
  if (!rows || !Array.isArray(rows)) return accounts;

  for (const row of rows) {
    const type = String(row?.type || "").toLowerCase();
    if (type !== "section") continue;

    const headerName =
      row?.Header?.ColData?.[0]?.value ||
      row?.Summary?.ColData?.[0]?.value ||
      row?.ColData?.[0]?.value ||
      "General Account";

    const summaryCols = row?.Summary?.ColData || [];
    const total = summaryCols.length
      ? findLastNumericValue(summaryCols)
      : findLastNumericValue(row?.ColData);

    const rowData = getChildRows(row);
    if (rowData.length > 0) {
      const directData = rowData.filter(
        (child) =>
          String(child?.type || "").toLowerCase() === "data" ||
          Array.isArray(child?.ColData),
      );

      if (directData.length > 0) {
        accounts.push({
          id: String(
            row?.id || `acc-${Math.random().toString(36).slice(2, 7)}`,
          ),
          name: String(headerName || "").replace(/^Total\s+/i, ""),
          total,
          transactions: extractTransactions(
            directData,
            reportDate,
            columnsMetadata,
          ),
        });
      }

      accounts.push(...findAccounts(rowData, reportDate, columnsMetadata));
    }
  }

  return accounts;
}

function parseDetailRows(rows, reportDate = "N/A", columnsMetadata = []) {
  const groups = [];
  if (!rows || !Array.isArray(rows)) return { groups };

  for (const row of rows) {
    const type = String(row?.type || "").toLowerCase();
    if (type !== "section") continue;

    const groupName = getRowLabel(row, "Main Section");
    const summaryCols = row?.Summary?.ColData || [];
    const total = summaryCols.length
      ? findLastNumericValue(summaryCols)
      : findLastNumericValue(row?.ColData);

    const childRows = getChildRows(row);
    const accounts = findAccounts(childRows, reportDate, columnsMetadata);

    if (accounts.length > 0) {
      groups.push({
        id: String(row?.id || row?.group || Math.random().toString()),
        name: groupName,
        total,
        accounts,
      });
      continue;
    }

    const directData = childRows.filter(
      (child) =>
        String(child?.type || "").toLowerCase() === "data" ||
        Array.isArray(child?.ColData),
    );

    if (directData.length > 0) {
      groups.push({
        id: String(row?.id || row?.group || Math.random().toString()),
        name: groupName,
        total,
        accounts: [
          {
            id: String(
              row?.Header?.ColData?.[0]?.id ||
              row?.id ||
              `acc-${normalizeKey(groupName)}`,
            ),
            name: groupName,
            total,
            transactions: extractTransactions(
              directData,
              reportDate,
              columnsMetadata,
            ),
          },
        ],
      });
      continue;
    }

    if (Array.isArray(row?.Rows?.Row)) {
      const subData = parseDetailRows(
        row.Rows.Row,
        reportDate,
        columnsMetadata,
      );
      groups.push(...subData.groups);
    }
  }

  return {
    groups: groups.filter(
      (group, index, self) =>
        index ===
        self.findIndex(
          (candidate) =>
            candidate.name === group.name &&
            candidate.accounts.length === group.accounts.length,
        ),
    ),
  };
}

export function parseSummaryReport(payload) {
  return parseSummaryRows(extractRows(payload));
}

export function parseDetailReport(payload) {
  const columnsMetadata =
    payload?.Columns?.Column || payload?.data?.Columns?.Column || [];
  return parseDetailRows(
    extractRows(payload),
    getReportDate(payload, "") || "",
    columnsMetadata,
  );
}

function balanceSheetCollectAccounts(row, reportDate, ledgerIndex) {
  const collected = [];
  const childRows = asArray(row?.Rows?.Row);

  childRows.forEach((child, index) => {
    const type = String(child?.type || "").toLowerCase();

    if (type === "data" || Array.isArray(child?.ColData)) {
      const accountName = String(child?.ColData?.[0]?.value || "Account");
      const accountId = child?.ColData?.[0]?.id
        ? String(child.ColData[0].id)
        : undefined;
      const total = findLastNumericValue(child?.ColData);

      const ledgerSection =
        (accountId ? ledgerIndex.byId.get(accountId) : undefined) ||
        ledgerIndex.byName.get(normalizeKey(accountName));

      collected.push({
        id: accountId || `bs-account-${normalizeKey(accountName)}-${index}`,
        name: accountName,
        total,
        transactions: ledgerSection
          ? extractTransactions(asArray(ledgerSection?.Rows?.Row), reportDate)
          : [],
      });
      return;
    }

    if (type === "section" || isSectionLikeRow(child)) {
      collected.push(
        ...balanceSheetCollectAccounts(child, reportDate, ledgerIndex),
      );
    }
  });

  return collected;
}

function balanceSheetBuildLedgerIndex(generalLedgerReport) {
  const byId = new Map();
  const byName = new Map();
  const allSections = new Set();
  const columns = generalLedgerReport?.Columns?.Column || [];

  const visit = (rows, parent = null) => {
    asArray(rows).forEach((section) => {
      if (!section) return;

      const headerCol = section?.Header?.ColData?.[0] || section?.ColData?.[0];
      const name = String(headerCol?.value || "");
      const id = headerCol?.id ? String(headerCol.id) : "";

      section.parent = parent;

      if (id && !byId.has(id)) byId.set(id, section);

      if (name) {
        getAltKeys(name).forEach((key) => {
          if (!byName.has(key)) byName.set(key, section);
        });
      }

      allSections.add(section);
      visit(getChildRows(section), section);
    });
  };

  visit(getChildRows(generalLedgerReport));

  return { byId, byName, columns: columns.length ? columns : [], allSections };
}

// Balance sheet detail view: use BalanceSheet structure + GeneralLedger transactions from `/all-reports`.
export function parseBalanceSheetDetailFromAllReports(
  payload,
  fallbackDate = "N/A",
) {
  try {
    const balanceSheetReport = pickQuickbooksReport(
      payload?.balanceSheet,
      payload?.BalanceSheet,
      payload?.data?.balanceSheet,
      payload?.data?.BalanceSheet,
    );

    const generalLedgerReport = pickQuickbooksReport(
      payload?.generalLedger,
      payload?.GeneralLedger,
      payload?.data?.generalLedger,
      payload?.data?.GeneralLedger,
    );

    if (!generalLedgerReport) {
      console.warn("⚠️ No General Ledger found for detailed parsing.");
      return null;
    }

    const reportDate =
      getReportDate(generalLedgerReport || balanceSheetReport, fallbackDate) ||
      fallbackDate;
    const ledgerIndex = balanceSheetBuildLedgerIndex(generalLedgerReport);

    const groups = [];
    const usedLedgerSections = new Set();
    const processedTransactionKeys = new Set();

    // Aggressive transaction extraction with de-duplication
    const extractDeDuped = (ledgerNode) => {
      const allRows = getChildRows(ledgerNode);
      const raw = extractTransactions(allRows, reportDate, ledgerIndex.columns);

      return raw.filter((tx) => {
        // Create a unique key for each transaction to prevent double-counting across BS and Safety Net
        const key =
          `${tx.date}-${tx.type}-${tx.num}-${tx.amount}-${tx.balance}-${tx.memo}-${tx.name}`.toLowerCase();
        if (processedTransactionKeys.has(key)) return false;
        processedTransactionKeys.add(key);
        return true;
      });
    };

    const traverseBS = (rows, parentName = "General") => {
      const list = asArray(rows);
      list.forEach((row) => {
        if (!row) return;
        const name = getRowLabel(row, parentName);
        if (isTotalLikeLabel(name)) return;

        const columns = row.ColData || [];
        const total = findLastNumericValue(columns);
        const id = columns[0]?.id || row.id;

        // Try ID match first, then name match
        let ledgerSection = id ? ledgerIndex.byId.get(String(id)) : undefined;
        if (!ledgerSection) {
          const keys = getAltKeys(name);
          for (const k of keys) {
            if (ledgerIndex.byName.has(k)) {
              ledgerSection = ledgerIndex.byName.get(k);
              break;
            }
          }
        }

        const transactions = ledgerSection ? extractDeDuped(ledgerSection) : [];
        if (ledgerSection) usedLedgerSections.add(ledgerSection);

        // Even if no transactions found in GL, we add the account with a "Summary Balance" transaction
        // if it represents a leaf node (Data row) or has a balance, to ensure UI parity.
        const isDataRow = row.type === "Data" || (!row.Rows && row.ColData);

        if (isDataRow || transactions.length > 0) {
          const finalTransactions =
            transactions.length > 0
              ? transactions
              : [
                {
                  id: `summary-${id || normalizeKey(name)}-${Math.random().toString(36).slice(2, 5)}`,
                  date: reportDate,
                  type: "Balance",
                  num: "",
                  name: "",
                  memo: "Ending Balance",
                  split: "",
                  amount: total,
                  balance: total,
                },
              ];

          accounts_ptr.push({
            id: id || `acc-${normalizeKey(name)}`,
            name,
            total,
            transactions: finalTransactions,
          });
        }

        const children = getChildRows(row);
        if (children.length > 0) {
          traverseBS(children, name);
        }
      });
    };

    // Since we need to push to groups, we wrap the traverse logic
    const topRows = asArray(balanceSheetReport?.Rows?.Row);
    topRows.forEach((mainRow) => {
      const groupName = getRowLabel(mainRow, "Miscellaneous");
      const accounts = [];
      const accounts_proxy = { push: (acc) => accounts.push(acc) };

      // Global reference for traverse to push to
      globalThis.accounts_ptr = accounts_proxy;
      traverseBS(getChildRows(mainRow), groupName);
      delete globalThis.accounts_ptr;

      if (accounts.length > 0) {
        groups.push({
          id: `group-${normalizeKey(groupName)}-${groups.length}`,
          name: groupName,
          total: accounts.reduce((sum, a) => sum + a.total, 0),
          accounts,
        });
      }
    });

    // CRITICAL RECOVERY: Iterate through EVERY branch of the General Ledger to find transactions
    // that weren't captured by the Balance Sheet traversal. This is the key to reaching 862.
    const remainingAccounts = [];
    ledgerIndex.allSections.forEach((section) => {
      if (usedLedgerSections.has(section)) return;

      const transactions = extractDeDuped(section);
      if (transactions.length > 0) {
        const name = getRowLabel(section, "Uncategorized Activity");
        remainingAccounts.push({
          id: `gl-acc-${Math.random().toString(36).slice(2, 7)}`,
          name,
          total: transactions.reduce((sum, t) => sum + (t.amount || 0), 0),
          transactions,
        });
      }
    });

    if (remainingAccounts.length > 0) {
      groups.push({
        id: "group-other-gl-activity",
        name: "Other Detailed Activity",
        total: remainingAccounts.reduce((sum, a) => sum + a.total, 0),
        accounts: remainingAccounts,
      });
    }

    return groups.length > 0 ? { groups } : null;
  } catch (err) {
    console.error("❌ parseBalanceSheetDetailFromAllReports failed:", err);
    return null;
  }
}

// --- Cashflow engine detail parser (ported from working project) ---
function cashflowNormalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function cashflowCreateStableId(prefix, ...parts) {
  const suffix = parts
    .filter(
      (part) =>
        part !== undefined && part !== null && String(part).trim() !== "",
    )
    .map((part) => cashflowNormalizeKey(String(part)))
    .filter(Boolean)
    .join("-");

  return suffix
    ? `${prefix}-${suffix}`
    : `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function cashflowGetSummaryRows(payload) {
  return (
    payload?.cashflow?.Rows?.Row ||
    payload?.Rows?.Row ||
    payload?.data?.Rows?.Row ||
    []
  );
}

function cashflowGetReportDate(payload, fallback) {
  return (
    payload?.cashflow?.Header?.EndPeriod ||
    payload?.Header?.EndPeriod ||
    payload?.data?.Header?.EndPeriod ||
    fallback ||
    "N/A"
  );
}

function cashflowGetRowName(row) {
  return String(
    row?.Header?.ColData?.[0]?.value ||
    row?.Summary?.ColData?.[0]?.value ||
    row?.ColData?.[0]?.value ||
    "Cash Flow Item",
  );
}

function cashflowGetRowTotal(row) {
  const colData = row?.Summary?.ColData || row?.ColData || [];
  const lastValue = colData[colData.length - 1]?.value;
  return toNumber(String(lastValue ?? ""));
}

function cashflowLineDescription(line) {
  return String(
    line?.Description ||
    line?.AccountBasedExpenseLineDetail?.AccountRef?.name ||
    line?.ItemBasedExpenseLineDetail?.ItemRef?.name ||
    line?.SalesItemLineDetail?.ItemRef?.name ||
    "Line Item",
  );
}

function cashflowAddTransaction(
  transactionMap,
  accountIds,
  accountNames,
  transaction,
) {
  const keys = new Set();

  asArray(accountIds).forEach((accountId) => {
    if (accountId) keys.add(`id:${accountId}`);
  });

  asArray(accountNames).forEach((accountName) => {
    if (accountName) keys.add(`name:${cashflowNormalizeKey(accountName)}`);
  });

  keys.forEach((key) => {
    const existing = transactionMap.get(key) || [];
    existing.push(transaction);
    transactionMap.set(key, existing);
  });
}

function cashflowBuildTransactionMap(payload, reportDate) {
  const transactionMap = new Map();
  const transactions = payload?.transactions || {};

  asArray(transactions?.invoices?.Invoice).forEach((invoice, index) => {
    const amount = -(invoice?.TotalAmt || 0);
    cashflowAddTransaction(
      transactionMap,
      ["84"],
      ["Accounts Receivable (A/R)"],
      {
        id: `invoice-${invoice?.Id || index}`,
        date: invoice?.TxnDate || reportDate,
        type: "Invoice",
        num: invoice?.DocNumber || "",
        name: invoice?.CustomerRef?.name || "Invoice",
        memo:
          invoice?.PrivateNote || cashflowLineDescription(invoice?.Line?.[0]),
        split: invoice?.ARAccountRef?.name || "Accounts Receivable",
        amount,
        balance: amount,
      },
    );
  });

  asArray(transactions?.payments?.Payment).forEach((payment, index) => {
    const amount = payment?.TotalAmt || 0;
    cashflowAddTransaction(
      transactionMap,
      ["84"],
      ["Accounts Receivable (A/R)"],
      {
        id: `payment-${payment?.Id || index}`,
        date: payment?.TxnDate || reportDate,
        type: "Payment",
        num: payment?.DocNumber || "",
        name: payment?.CustomerRef?.name || "Payment",
        memo:
          payment?.PrivateNote || cashflowLineDescription(payment?.Line?.[0]),
        split: payment?.DepositToAccountRef?.name || "Payment",
        amount,
        balance: amount,
      },
    );
  });

  asArray(transactions?.bills?.Bill).forEach((bill, index) => {
    const vendorName = bill?.VendorRef?.name || "Bill";

    asArray(bill?.Line).forEach((line, lineIndex) => {
      const accountId =
        line?.AccountBasedExpenseLineDetail?.AccountRef?.value ||
        line?.ItemBasedExpenseLineDetail?.ItemRef?.value;
      const accountName =
        line?.AccountBasedExpenseLineDetail?.AccountRef?.name ||
        line?.ItemBasedExpenseLineDetail?.ItemRef?.name;
      if (!accountId && !accountName) return;

      const amount = -(line?.Amount || 0);
      cashflowAddTransaction(transactionMap, [accountId], [accountName], {
        id: `bill-${bill?.Id || index}-${lineIndex}`,
        date: bill?.TxnDate || reportDate,
        type: "Bill",
        num: bill?.DocNumber || "",
        name: vendorName,
        memo: bill?.PrivateNote || cashflowLineDescription(line),
        split: accountName || "Expense Account",
        amount,
        balance: amount,
      });
    });
  });

  asArray(transactions?.purchases?.Purchase).forEach((purchase, index) => {
    const accountId = purchase?.AccountRef?.value;
    const accountName = purchase?.AccountRef?.name;
    const amount = -(purchase?.TotalAmt || 0);

    cashflowAddTransaction(transactionMap, [accountId], [accountName], {
      id: `purchase-${purchase?.Id || index}`,
      date: purchase?.TxnDate || reportDate,
      type: purchase?.PaymentType || "Purchase",
      num: purchase?.DocNumber || "",
      name: purchase?.EntityRef?.name || accountName || "Purchase",
      memo:
        purchase?.PrivateNote || cashflowLineDescription(purchase?.Line?.[0]),
      split: accountName || "Expense Account",
      amount,
      balance: amount,
    });
  });

  asArray(transactions?.deposits?.Deposit).forEach((deposit, index) => {
    asArray(deposit?.Line).forEach((line, lineIndex) => {
      const accountId = line?.DepositLineDetail?.AccountRef?.value;
      const accountName = line?.DepositLineDetail?.AccountRef?.name;
      if (!accountId && !accountName) return;

      const amount = line?.Amount || 0;
      cashflowAddTransaction(transactionMap, [accountId], [accountName], {
        id: `deposit-${deposit?.Id || index}-${lineIndex}`,
        date: deposit?.TxnDate || reportDate,
        type: "Deposit",
        num: "",
        name: accountName || "Deposit",
        memo: deposit?.PrivateNote || cashflowLineDescription(line),
        split: deposit?.DepositToAccountRef?.name || "Deposit",
        amount,
        balance: amount,
      });
    });
  });

  return transactionMap;
}

function cashflowGetAccountTransactions(
  accountId,
  accountName,
  total,
  reportDate,
  transactionMap,
) {
  const byId = accountId ? transactionMap.get(`id:${accountId}`) : undefined;
  const byName = transactionMap.get(
    `name:${cashflowNormalizeKey(accountName)}`,
  );
  const transactions = [...(byId || []), ...(byName || [])];

  if (transactions.length > 0) {
    return transactions.filter(
      (transaction, index, self) =>
        index ===
        self.findIndex((candidate) => candidate.id === transaction.id),
    );
  }

  return [
    {
      id: cashflowCreateStableId("cashflow-fallback", accountId, accountName),
      date: reportDate,
      type: "Summary",
      num: "",
      name: accountName,
      memo: "Generated from cash flow summary",
      split: accountName,
      amount: total,
      balance: total,
    },
  ];
}

function cashflowCollectAccounts(rows, reportDate, transactionMap) {
  const accounts = [];

  asArray(rows).forEach((row, index) => {
    const type = String(row?.type || "").toLowerCase();

    if (type === "data" || !row?.type) {
      const accountName = cashflowGetRowName(row);
      const accountId = row?.ColData?.[0]?.id;
      const total = cashflowGetRowTotal(row);
      accounts.push({
        id: String(
          accountId ||
          row?.group ||
          cashflowCreateStableId("cashflow-account", accountName, index),
        ),
        name: accountName,
        total,
        transactions: cashflowGetAccountTransactions(
          accountId,
          accountName,
          total,
          reportDate,
          transactionMap,
        ),
      });
      return;
    }

    if (type === "section") {
      const nestedRows = asArray(row?.Rows?.Row);
      if (nestedRows.length > 0) {
        accounts.push(
          ...cashflowCollectAccounts(nestedRows, reportDate, transactionMap),
        );
        return;
      }

      const accountName = cashflowGetRowName(row);
      const total = cashflowGetRowTotal(row);
      accounts.push({
        id: String(
          row?.group ||
          cashflowCreateStableId("cashflow-account", accountName, index),
        ),
        name: accountName,
        total,
        transactions: cashflowGetAccountTransactions(
          undefined,
          accountName,
          total,
          reportDate,
          transactionMap,
        ),
      });
    }
  });

  return accounts;
}

export function parseCashflowEngineDetailReport(payload, fallbackDate) {
  const reportDate = cashflowGetReportDate(payload, fallbackDate);
  const rows = cashflowGetSummaryRows(payload);
  const transactionMap = cashflowBuildTransactionMap(payload, reportDate);

  const groups = asArray(rows).map((row, index) => {
    const groupName = cashflowGetRowName(row);
    const total = cashflowGetRowTotal(row);
    const accounts = row?.Rows?.Row
      ? cashflowCollectAccounts(
        asArray(row.Rows.Row),
        reportDate,
        transactionMap,
      )
      : [
        {
          id: String(
            row?.group ||
            cashflowCreateStableId("cashflow-account", groupName, index),
          ),
          name: groupName,
          total,
          transactions: cashflowGetAccountTransactions(
            undefined,
            groupName,
            total,
            reportDate,
            transactionMap,
          ),
        },
      ];

    return {
      id: String(
        row?.group ||
        cashflowCreateStableId("cashflow-group", groupName, index),
      ),
      name: groupName,
      total,
      accounts,
    };
  });

  return {
    groups,
    grandTotal: groups.reduce(
      (sum, group) => sum + Number(group.total || 0),
      0,
    ),
  };
}
