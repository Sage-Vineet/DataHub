import { fetchGeneralLedger } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";

// Handles both plain "-500.00" and QB parentheses notation "(500.00)" for negatives.
function toAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const s = String(value || "").trim();
  if (!s || s === "—" || s === "-") return 0;
  const isNeg = (s.startsWith("(") && s.endsWith(")")) || s.startsWith("-");
  const digits = s.replace(/[^0-9.]/g, "");
  const parsed = parseFloat(digits);
  if (!Number.isFinite(parsed)) return 0;
  return isNeg ? -Math.abs(parsed) : Math.abs(parsed);
}

function normAcct(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Detect Name and Amount column indices from QB report's Columns metadata.
 * Falls back to the standard QB GeneralLedger column layout if metadata is absent.
 */
function detectColumnIndices(glData) {
  // glData may be the full response OR just the QB report object
  const report = glData?.data || glData;
  const cols = report?.Columns?.Column;

  if (Array.isArray(cols) && cols.length > 0) {
    let dateIdx = -1;
    let nameIdx = -1;
    let amountIdx = -1;

    cols.forEach((col, i) => {
      const type = String(col?.ColType || "").toLowerCase();
      const title = String(col?.ColTitle || "").toLowerCase();
      if (type === "tx_date" || title === "date") dateIdx = i;
      else if (type === "entity_name" || title === "name") nameIdx = i;
      else if (type === "subt_nat_amount" || title === "amount") amountIdx = i;
    });

    // If we found at least the name and amount columns, trust the metadata.
    if (nameIdx >= 0 && amountIdx >= 0) {
      return { dateIdx: dateIdx >= 0 ? dateIdx : 0, nameIdx, amountIdx };
    }
  }

  // Standard QB GeneralLedger layout: Date(0) TxnType(1) Num(2) Name(3) Memo(4) Split(5) Amount(6) Balance(7)
  return { dateIdx: 0, nameIdx: 3, amountIdx: 6 };
}

/**
 * Extracts the raw Rows.Row array from the QB API response regardless of nesting depth.
 */
function extractGLRows(payload) {
  return (
    payload?.Rows?.Row ||
    payload?.data?.Rows?.Row ||
    payload?.data?.data?.Rows?.Row ||
    null
  );
}

/**
 * Parses a QB General Ledger response into a vendor breakdown map.
 *
 * Returns:
 *   { [normalizedAccountName]: { [vendorName]: { [periodKey]: amount } } }
 *
 * @param {Object} glPayload  - Full response from GET /general-ledger
 * @param {Array}  periods    - [{key, startDate|start, endDate|end}, ...]
 */
export function parseQBGLVendors(glPayload, periods) {
  const result = {};

  const reportData = glPayload?.data || glPayload;
  const rawRows = extractGLRows(reportData);
  if (!rawRows) {
    console.warn("[QBVendor] parseQBGLVendors: no Rows.Row found in GL response");
    return result;
  }
  const topRows = Array.isArray(rawRows) ? rawRows : [rawRows];

  // Detect column positions dynamically from the report's column metadata.
  const { dateIdx, nameIdx, amountIdx } = detectColumnIndices(reportData);

  // Normalise periods so both BS (startDate/endDate) and P&L (start/end) shapes work.
  const normPeriods = periods
    .map((p) => ({
      key: p.key,
      startDate: p.startDate || p.start || "",
      endDate: p.endDate || p.end || "",
    }))
    .filter((p) => p.startDate && p.endDate);

  if (!normPeriods.length) {
    console.warn("[QBVendor] parseQBGLVendors: no valid periods, skipping");
    return result;
  }

  const periodDateCache = normPeriods.map((p) => ({
    key: p.key,
    start: new Date(p.startDate),
    end: new Date(p.endDate),
  }));

  const attributeTx = (accountKey, cols) => {
    if (!accountKey || !Array.isArray(cols) || cols.length === 0) return;

    const dateStr = String(cols[dateIdx]?.value || "").trim();
    if (!dateStr) return;
    const txDate = new Date(dateStr);
    if (isNaN(txDate.getTime())) return;

    // Try the detected nameIdx, then surrounding columns as fallbacks.
    const nameRaw =
      String(cols[nameIdx]?.value || "").trim() ||
      String(cols[nameIdx + 1]?.value || "").trim() ||
      "";
    const vendor = nameRaw || "No vendor / —";

    const amount = toAmount(cols[amountIdx]?.value);
    // Skip zero-amount rows; they add noise without contributing to totals.
    if (!amount) return;

    for (const p of periodDateCache) {
      if (txDate >= p.start && txDate <= p.end) {
        if (!result[accountKey]) result[accountKey] = {};
        if (!result[accountKey][vendor]) result[accountKey][vendor] = {};
        result[accountKey][vendor][p.key] = (result[accountKey][vendor][p.key] || 0) + amount;
        break;
      }
    }
  };

  const processSection = (section, parentKey) => {
    const headerName = section.Header?.ColData?.[0]?.value || "";
    const accountKey = parentKey || normAcct(headerName);
    if (!accountKey) return;

    const txRows = Array.isArray(section.Rows?.Row)
      ? section.Rows.Row
      : section.Rows?.Row
      ? [section.Rows.Row]
      : [];

    for (const row of txRows) {
      if (row.type === "Data") {
        attributeTx(accountKey, row.ColData || []);
      } else if (row.type === "Section") {
        // Sub-account sections — attribute transactions back to the top account.
        processSection(row, accountKey);
      }
    }
  };

  for (const row of topRows) {
    if (row.type === "Section") processSection(row, null);
  }

  const acctCount = Object.keys(result).length;
  if (acctCount > 0) {
    const sample = Object.keys(result)[0];
    const sampleVendors = Object.keys(result[sample]).slice(0, 3);
    console.log(`[QBVendor] Parsed ${acctCount} accounts. Sample: "${sample}" → vendors: ${JSON.stringify(sampleVendors)}`);
  } else {
    console.warn("[QBVendor] parseQBGLVendors: no account data extracted — check column indices or GL row structure");
    console.log("[QBVendor] Detected indices:", { dateIdx, nameIdx, amountIdx }, "| topRows sample:", JSON.stringify(topRows[0]).slice(0, 300));
  }

  return result;
}

/**
 * Walks a row tree and attaches a `vendors` array to each leaf (data) node
 * that has matching GL transactions.
 *
 * Account names are matched using normalised exact match first, then
 * partial/substring matching to handle GL names that include account numbers
 * (e.g. "4100 · Design income") or parent path prefixes.
 *
 * @param {Array}  rows              - Report row tree
 * @param {Object} vendorMap         - From parseQBGLVendors
 * @param {Array}  displayPeriodKeys - Only include these period keys (yearCol keys)
 */
export function attachVendorsToRows(rows, vendorMap, displayPeriodKeys) {
  if (!rows?.length || !vendorMap || !Object.keys(vendorMap).length) return rows;

  const vendorKeys = Object.keys(vendorMap);

  // Returns the vendorMap key that best matches rowName, or null.
  const findVendorKey = (rowName) => {
    const norm = normAcct(rowName);
    if (!norm) return null;

    // 1. Exact normalised match
    if (vendorMap[norm]) return norm;

    // 2. Partial match — GL key contains row name or vice versa
    //    Handles account numbers like "4100 · design income" or path-prefixed "income:design income"
    for (const key of vendorKeys) {
      if (key === norm) return key;
      const keyStripped = key.replace(/^\d+\s*[·:.·\-]+\s*/, ""); // strip leading account number
      if (keyStripped === norm || key.endsWith(`:${norm}`) || key.endsWith(` ${norm}`)) return key;
      if (key.includes(norm) && norm.length >= 4) return key;
      if (norm.includes(key) && key.length >= 4) return key;
    }

    return null;
  };

  const attach = (node) => {
    const isLeaf = node.type !== "header" && node.type !== "total";
    let vendors;

    if (isLeaf) {
      const key = findVendorKey(node.name);
      const byVendor = key ? vendorMap[key] : null;
      if (byVendor) {
        const list = Object.entries(byVendor)
          .map(([vendorName, periodAmounts]) => {
            const filtered = displayPeriodKeys
              ? Object.fromEntries(
                  Object.entries(periodAmounts).filter(([k]) =>
                    displayPeriodKeys.includes(k),
                  ),
                )
              : periodAmounts;
            const total = Object.values(filtered).reduce(
              (s, v) => s + (v || 0),
              0,
            );
            return { name: vendorName, amounts: filtered, total };
          })
          .filter((v) => v.total !== 0)
          .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

        if (list.length > 0) vendors = list;
      }
    }

    return {
      ...node,
      ...(vendors ? { vendors } : {}),
      children: node.children ? node.children.map(attach) : undefined,
    };
  };

  return rows.map(attach);
}

/**
 * Fetches QB GL for a date range and returns the parsed vendor breakdown map.
 *
 * @param {string} startDate       - Earliest period start (YYYY-MM-DD)
 * @param {string} endDate         - Latest period end (YYYY-MM-DD)
 * @param {string} accountingMethod
 * @param {Array}  periods         - Period definitions (used for transaction bucketing)
 */
export async function fetchQBVendorBreakdown(
  startDate,
  endDate,
  accountingMethod,
  periods,
) {
  try {
    // fresh=true tells the backend to fetch live from QB for this date range
    // instead of serving a potentially empty or mismatched cached snapshot.
    const params = { fresh: "true" };
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    const normalised = normalizeAccountingMethod(accountingMethod);
    if (normalised) params.accounting_method = normalised;

    console.log("[QBVendor] Fetching GL (live):", params, "| periods:", periods?.length);
    const glData = await fetchGeneralLedger(params);
    if (!glData) {
      console.warn("[QBVendor] fetchGeneralLedger returned empty response");
      return {};
    }

    return parseQBGLVendors(glData, periods);
  } catch (err) {
    console.warn("[QBVendor] GL vendor breakdown fetch failed:", err.message);
    return {};
  }
}
