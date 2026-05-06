import XLSX from "xlsx-js-style";

export async function buildStyledReconciliationExcel({
  startDate,
  endDate,
  reportMonths,
  visibleBalanceAccounts,
  qbBankActivity,
  buildAccountBalanceDataFromQB,
  activityRows,
  activityTTM,
  BALANCE_EXPORT_METRICS,
  ACTIVITY_EXPORT_METRICS,
}) {
  const wb = XLSX.utils.book_new();

  const headerFill = { fgColor: { rgb: "F8FBF1" } };
  const activityHeaderFill = { fgColor: { rgb: "4472C4" } };

  const titleFont = { name: "Arial", sz: 10, bold: true, color: { rgb: "000000" } };
  const activityTitleFont = { name: "Arial", sz: 12, bold: true, color: { rgb: "FFFFFF" } };
  const subHeaderFont = { name: "Arial", sz: 9, bold: true, color: { rgb: "70AD47" } };
  const regularFont = { name: "Arial", sz: 9, color: { rgb: "000000" } };
  const boldFont = { name: "Arial", sz: 9, bold: true, color: { rgb: "000000" } };

  const thinBorder = { style: "thin", color: { rgb: "000000" } };
  const mediumBorder = { style: "medium", color: { rgb: "000000" } };

  const aoa = [];
  const merges = [];

  const accountsForExport = qbBankActivity?.accounts || [];

  const formatNumber = (num) => {
    if (num == null || isNaN(num) || num === 0) return 0;
    return Number(num);
  };

  const numberFormat = '#,##0.00;[Red](#,##0.00);"-"';
  const pctFormat = '0.0%;[Red]-0.0%;"-"';

  let currentRowIdx = 0; // 0-indexed for AOA

  // Render Each Bank Account
  accountsForExport.forEach((account) => {
    const { rows: accRows, ttm } = buildAccountBalanceDataFromQB(account);
    const accountName = `${account.accountName}${account.accountNumber ? ` (${account.accountNumber})` : ""}`;

    const startRowIdx = currentRowIdx;

    // Account Name Header
    const row0 = [];
    row0[0] = { v: accountName, s: { font: titleFont } };
    aoa.push(row0);
    currentRowIdx++;

    // Subheader row
    const row1 = [];
    row1[0] = { v: "Bank Statement", s: { font: subHeaderFont, fill: headerFill } };
    reportMonths.forEach((month, colIdx) => {
      const date = new Date(`${month}-01T00:00:00Z`);
      const monthStr = `${date.toLocaleString("default", { month: "short" })} ${date.getFullYear().toString().slice(2)}`;
      row1[colIdx + 1] = { v: monthStr, s: { font: subHeaderFont, fill: headerFill, alignment: { horizontal: "right" } } };
    });
    row1[reportMonths.length + 1] = { v: "Total", s: { font: subHeaderFont, fill: headerFill, alignment: { horizontal: "right" } } };
    aoa.push(row1);
    currentRowIdx++;

    // Data Rows
    BALANCE_EXPORT_METRICS.forEach((metric) => {
      const row = [];
      row[0] = { v: metric.label, s: { font: regularFont } };
      
      const isPct = metric.key.includes("Pct") || metric.label.includes("%");
      const numFmt = isPct ? pctFormat : numberFormat;

      reportMonths.forEach((month, colIdx) => {
        const match = accRows.find((entry) => entry.month === month);
        const val = match?.[metric.key] ?? 0;
        row[colIdx + 1] = { v: formatNumber(val), t: "n", z: numFmt, s: { font: regularFont } };
      });

      const totalVal = ttm?.[metric.key] ?? 0;
      row[reportMonths.length + 1] = { v: formatNumber(totalVal), t: "n", z: numFmt, s: { font: regularFont } };
      
      aoa.push(row);
      currentRowIdx++;
    });

    // Apply borders to the account block
    for (let r = startRowIdx; r < currentRowIdx; r++) {
      for (let c = 0; c <= reportMonths.length + 1; c++) {
        if (!aoa[r][c]) aoa[r][c] = { v: "", s: {} };
        if (!aoa[r][c].s) aoa[r][c].s = {};
        if (!aoa[r][c].s.border) aoa[r][c].s.border = {};
        
        if (r === startRowIdx) aoa[r][c].s.border.top = mediumBorder;
        if (r === currentRowIdx - 1) aoa[r][c].s.border.bottom = mediumBorder;
        if (c === 0) aoa[r][c].s.border.left = mediumBorder;
        if (c === reportMonths.length + 1) aoa[r][c].s.border.right = mediumBorder;
      }
    }

    aoa.push([]);
    aoa.push([]);
    currentRowIdx += 2;
  });

  // Render Activity Review Section
  const activityStartRowIdx = currentRowIdx;
  
  const titleRow = [];
  titleRow[0] = { v: "Activity Review", s: { font: activityTitleFont, fill: activityHeaderFill } };
  for (let c = 1; c <= reportMonths.length + 1; c++) {
    titleRow[c] = { v: "", s: { fill: activityHeaderFill } };
  }
  aoa.push(titleRow);
  merges.push({ s: { r: currentRowIdx, c: 0 }, e: { r: currentRowIdx, c: reportMonths.length + 1 } });
  currentRowIdx++;

  ACTIVITY_EXPORT_METRICS.forEach((metric) => {
    const row = [];
    const isBold = ["External Deposits", "Unreconciled Variance $", "Unreconciled Variance %", "External Withdraws", "Net Unreconciled Outage", "Total Withdrawals", "Total Deposits"].includes(metric.label);
    const font = isBold ? boldFont : regularFont;
    
    let label = metric.label;
    if (!isBold && !["$ Variance", "% Variance", "Reconciling Items"].includes(label)) {
      label = "    " + label;
    }
    
    const rowBorders = isBold ? { top: thinBorder, bottom: thinBorder } : {};
    
    row[0] = { v: label, s: { font, border: { ...rowBorders } } };

    const isPct = metric.key.includes("Pct") || metric.label.includes("%");
    const numFmt = isPct ? pctFormat : numberFormat;

    reportMonths.forEach((month, colIdx) => {
      const match = activityRows.find((entry) => entry.month === month);
      const val = match?.[metric.key] ?? 0;
      row[colIdx + 1] = { v: formatNumber(val), t: "n", z: numFmt, s: { font, border: { ...rowBorders } } };
    });

    const totalVal = activityTTM?.[metric.key] ?? 0;
    row[reportMonths.length + 1] = { v: formatNumber(totalVal), t: "n", z: numFmt, s: { font, border: { ...rowBorders } } };

    aoa.push(row);
    currentRowIdx++;
  });

  // Add outer border for activity block
  for (let r = activityStartRowIdx; r < currentRowIdx; r++) {
    for (let c = 0; c <= reportMonths.length + 1; c++) {
      if (!aoa[r][c]) aoa[r][c] = { v: "", s: {} };
      if (!aoa[r][c].s) aoa[r][c].s = {};
      if (!aoa[r][c].s.border) aoa[r][c].s.border = {};
      
      if (c === 0) aoa[r][c].s.border.left = { ...aoa[r][c].s.border.left, ...mediumBorder };
      if (c === reportMonths.length + 1) aoa[r][c].s.border.right = { ...aoa[r][c].s.border.right, ...mediumBorder };
      if (r === currentRowIdx - 1) aoa[r][c].s.border.bottom = { ...aoa[r][c].s.border.bottom, ...mediumBorder };
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  
  const cols = [ { wch: 35 } ];
  reportMonths.forEach(() => cols.push({ wch: 14 }));
  cols.push({ wch: 14 });
  ws["!cols"] = cols;

  XLSX.utils.book_append_sheet(wb, ws, "Bank Reconciliation");

  const buffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
