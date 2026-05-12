import * as XLSX from "xlsx";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";


export function flattenSummaryData(lines, depth = 0, rows = []) {
  for (const line of Array.isArray(lines) ? lines : []) {
    rows.push({
      "Accounting Classification": `${"  ".repeat(depth)}${line.name || ""}`,
      "Amount (USD)": Number(line.amount || 0),
    });

    if (Array.isArray(line.children) && line.children.length > 0) {
      flattenSummaryData(line.children, depth + 1, rows);
    }
  }

  return rows;
}

export function flattenMultiYearData(lines, columns, depth = 0, rows = []) {
  const yearCols = columns?.yearCols || [];
  const ytdComp = columns?.ytdComparison || {};

  for (const line of Array.isArray(lines) ? lines : []) {
    const row = {
      "Accounting Classification": `${"  ".repeat(depth)}${line.name || ""}`,
    };

    // Add year columns
    yearCols.forEach((col) => {
      row[col.label] = Number(line.amounts?.[col.key] || 0);
    });

    // Add YTD columns if available
    if (ytdComp.currentKey) {
      row[ytdComp.currentLabel || "Current YTD"] = Number(
        line.amounts?.[ytdComp.currentKey] || 0,
      );
    }
    if (ytdComp.prevKey) {
      row[ytdComp.prevLabel || "Prev YTD"] = Number(
        line.amounts?.[ytdComp.prevKey] || 0,
      );
    }

    rows.push(row);

    if (Array.isArray(line.children) && line.children.length > 0) {
      flattenMultiYearData(line.children, columns, depth + 1, rows);
    }
  }

  return rows;
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function formatSheetName(name) {
  return String(name || "Report").replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
}

function isBalanceSheetReport(reportName) {
  return String(reportName || "").toLowerCase() === "balance sheet";
}

function isProfitAndLossReport(reportName) {
  const normalized = String(reportName || "").toLowerCase();
  return normalized === "profit & loss" || normalized === "profit and loss";
}

function parseDateInput(value) {
  if (!value || value === "N/A") return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLongDate(value) {
  const date = parseDateInput(value);
  if (!date) return value || "";
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(value) {
  const date = parseDateInput(value);
  if (!date) return value || "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildProfitAndLossPeriodText(startDate, endDate) {
  if (startDate === "1970-01-01") return "All Dates";
  const start = formatLongDate(startDate);
  const end = formatLongDate(endDate);
  if (start && end) return `${start}-${end}`;
  return start || end || "";
}

function buildBalanceSheetPeriodText(endDate) {
  const formatted = formatShortDate(endDate);
  return formatted ? `As of ${formatted}` : "As of";
}

function buildQuickBooksFooter(accountingMethod, createdOn) {
  const basis = accountingMethod ? `${accountingMethod} Basis` : "";
  return [basis, createdOn].filter(Boolean).join(" ");
}

function isTotalRow(line) {
  return (
    String(line?.type || "").toLowerCase() === "total" ||
    /^total\b/i.test(String(line?.name || "")) ||
    /^net\b/i.test(String(line?.name || ""))
  );
}

function isHeaderRow(line) {
  return (
    String(line?.type || "").toLowerCase() === "header" ||
    (Array.isArray(line?.children) && line.children.length > 0)
  );
}

function indentLabel(label, depth) {
  return `${"    ".repeat(Math.max(depth, 0))}${label || ""}`;
}

function addFormattedTreeRows(lines, buildRow, depth = 0, rows = [], meta = []) {
  for (const line of Array.isArray(lines) ? lines : []) {
    rows.push(buildRow(line, depth));
    meta.push({
      isHeader: isHeaderRow(line),
      isTotal: isTotalRow(line),
      depth,
      line,
    });

    if (Array.isArray(line.children) && line.children.length > 0) {
      addFormattedTreeRows(line.children, buildRow, depth + 1, rows, meta);
    }
  }

  return { rows, meta };
}

function setCellStyle(sheet, rowIndex, columnIndex, style) {
  const ref = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  if (!sheet[ref]) return;
  sheet[ref].s = {
    ...(sheet[ref].s || {}),
    ...style,
    font: {
      ...((sheet[ref].s || {}).font || {}),
      ...(style.font || {}),
    },
  };
}

const BALANCE_SHEET_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:x16r2="http://schemas.microsoft.com/office/spreadsheetml/2015/02/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"><numFmts count="1"><numFmt numFmtId="164" formatCode="\\$#,##0.00;\\-$#,##0.00"/></numFmts><fonts count="8" x14ac:knownFonts="1"><font><sz val="12"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="12"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><sz val="8"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="8"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="9"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="12"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="14"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF000000"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="2"/></cellStyleXfs><cellXfs count="19"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="2"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="3"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="2"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="1"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="4"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="3"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="4" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf numFmtId="164" fontId="3" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf numFmtId="0" fontId="7" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf></cellXfs><cellStyles count="4"><cellStyle name="GroupedCellStyle" xfId="2" xr:uid="{00000000-0005-0000-0000-000007000000}"/><cellStyle name="HeaderCellStyle" xfId="1" xr:uid="{00000000-0005-0000-0000-000006000000}"/><cellStyle name="Normal" xfId="0" builtinId="0"/><cellStyle name="TotalCellStyle" xfId="3" xr:uid="{00000000-0005-0000-0000-000008000000}"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

const PROFIT_AND_LOSS_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:x16r2="http://schemas.microsoft.com/office/spreadsheetml/2015/02/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision"><numFmts count="1"><numFmt numFmtId="164" formatCode="\\$#,##0.00;\\-$#,##0.00"/></numFmts><fonts count="8" x14ac:knownFonts="1"><font><sz val="12"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="12"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><sz val="8"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="8"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="9"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="12"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="14"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF000000"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="2"/></cellStyleXfs><cellXfs count="16"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="7" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1" indent="1"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf numFmtId="4" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf numFmtId="4" fontId="3" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf><xf numFmtId="164" fontId="3" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" wrapText="1"/></xf></cellXfs><cellStyles count="4"><cellStyle name="GroupedCellStyle" xfId="2" xr:uid="{00000000-0005-0000-0000-000007000000}"/><cellStyle name="HeaderCellStyle" xfId="1" xr:uid="{00000000-0005-0000-0000-000006000000}"/><cellStyle name="Normal" xfId="0" builtinId="0"/><cellStyle name="TotalCellStyle" xfId="3" xr:uid="{00000000-0005-0000-0000-000008000000}"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

function saveWorkbookArray(arrayBuffer, fileName) {
  const blob = new Blob([arrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName || "report"}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getCellStyleId(cellRef, rowMetaByExcelRow, footerRowNumber) {
  const match = String(cellRef || "").match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const [, column, rowString] = match;
  const rowNumber = Number(rowString);
  if (rowNumber === 1) return column === "A" ? 14 : 15;
  if (rowNumber === 2) return column === "A" ? 16 : 15;
  if (rowNumber === 3) return column === "A" ? 17 : 15;
  if (rowNumber === 5) return 11;
  if (rowNumber === footerRowNumber) return column === "A" ? 18 : 15;

  const meta = rowMetaByExcelRow.get(rowNumber);
  if (!meta) return null;
  if (column === "B") return meta.isTotal ? 13 : 12;

  if (meta.isTotal) {
    if (meta.depth <= 0) return 8;
    if (meta.depth === 1) return 7;
    if (meta.depth === 2) return 6;
    return 10;
  }

  return Math.min(2 + meta.depth, 9);
}

function getProfitAndLossCellStyleId(cellRef, rowMetaByExcelRow, footerRowNumber, columnCount) {
  const match = String(cellRef || "").match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const [, column, rowString] = match;
  const rowNumber = Number(rowString);
  const columnIndex = XLSX.utils.decode_col(column);
  const isLastColumn = columnIndex === columnCount - 1;

  if (rowNumber === 1) return column === "A" ? 5 : 4;
  if (rowNumber === 2) return column === "A" ? 3 : 4;
  if (rowNumber === 3) return column === "A" ? 2 : 4;
  if (rowNumber === 5) return 10;
  if (rowNumber === footerRowNumber) return column === "A" ? 1 : 4;

  const meta = rowMetaByExcelRow.get(rowNumber);
  if (!meta) return null;
  if (column === "A") {
    if (meta.isTotal) return 8;
    if (meta.isHeader) return 6;
    return 7;
  }

  if (meta.isTotal) return isLastColumn ? 15 : 13;
  return 12;
}

function buildProfitAndLossColsXml(columnCount) {
  const widths = [25.5, 16.09765625, 15.19921875, 16.09765625, 15.19921875, 16.09765625, 17, 16.09765625, 16.09765625, 8.3984375, 16.09765625, 16.09765625, 16.09765625, 20.3984375];
  return `<cols>${Array.from({ length: columnCount }, (_, index) => {
    const width = widths[index] || (index === columnCount - 1 ? 20.3984375 : 16.09765625);
    return `<col min="${index + 1}" max="${index + 1}" width="${width}" style="9" customWidth="1"/>`;
  }).join("")}</cols>`;
}

function patchBalanceSheetWorksheetXml(xml, rowMeta) {
  const footerMatch = xml.match(/<mergeCell ref="A(\d+):B\1"\/>/g);
  const footerRowNumber = footerMatch
    ? Number(footerMatch[footerMatch.length - 1].match(/\d+/)?.[0] || 0)
    : rowMeta.length + 9;
  const rowMetaByExcelRow = new Map(
    rowMeta.map((meta, index) => [index + 6, meta]),
  );
  let patched = xml
    .replace(
      /<sheetFormatPr[^>]*\/>/,
      '<sheetFormatPr defaultColWidth="11.296875" defaultRowHeight="15.6" x14ac:dyDescent="0.3"/>',
    )
    .replace(
      /<cols>[\s\S]*?<\/cols>/,
      '<cols><col min="1" max="1" width="33.19921875" style="1" customWidth="1"/><col min="2" max="2" width="16.09765625" style="1" customWidth="1"/></cols>',
    )
    .replace(/<pageSetup[^>]*\/>/, '<pageSetup orientation="portrait"/>');

  if (!/<cols>/.test(patched)) {
    patched = patched.replace(
      /(<sheetFormatPr[^>]*\/>)/,
      '$1<cols><col min="1" max="1" width="33.19921875" style="1" customWidth="1"/><col min="2" max="2" width="16.09765625" style="1" customWidth="1"/></cols>',
    );
  }

  return patched.replace(/<c\b([^>]*\br="([^"]+)"[^>]*)>/g, (match, attrs, ref) => {
    const styleId = getCellStyleId(ref, rowMetaByExcelRow, footerRowNumber);
    if (styleId === null) return match;
    const nextAttrs = /\bs="\d+"/.test(attrs)
      ? attrs.replace(/\bs="\d+"/, `s="${styleId}"`)
      : `${attrs} s="${styleId}"`;
    return `<c${nextAttrs}>`;
  });
}

function patchProfitAndLossWorksheetXml(xml, rowMeta, columnCount) {
  const footerMatch = xml.match(/<mergeCell ref="A(\d+):[A-Z]+\1"\/>/g);
  const footerRowNumber = footerMatch
    ? Number(footerMatch[footerMatch.length - 1].match(/\d+/)?.[0] || 0)
    : rowMeta.length + 9;
  const rowMetaByExcelRow = new Map(
    rowMeta.map((meta, index) => [index + 6, meta]),
  );
  let patched = xml
    .replace(
      /<sheetFormatPr[^>]*\/>/,
      '<sheetFormatPr defaultColWidth="11.296875" defaultRowHeight="15.6" x14ac:dyDescent="0.3"/>',
    )
    .replace(/<cols>[\s\S]*?<\/cols>/, buildProfitAndLossColsXml(columnCount))
    .replace(/<pageSetup[^>]*\/>/, '<pageSetup orientation="landscape"/>');

  if (!/<cols>/.test(patched)) {
    patched = patched.replace(
      /(<sheetFormatPr[^>]*\/>)/,
      `$1${buildProfitAndLossColsXml(columnCount)}`,
    );
  }

  return patched.replace(/<c\b([^>]*\br="([^"]+)"[^>]*)>/g, (match, attrs, ref) => {
    const styleId = getProfitAndLossCellStyleId(ref, rowMetaByExcelRow, footerRowNumber, columnCount);
    if (styleId === null) return match;
    const nextAttrs = /\bs="\d+"/.test(attrs)
      ? attrs.replace(/\bs="\d+"/, `s="${styleId}"`)
      : `${attrs} s="${styleId}"`;
    return `<c${nextAttrs}>`;
  });
}

function writeStyledWorkbook({ workbook, fileName, rowMeta, stylesXml, patchWorksheetXml }) {
  const output = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "array",
    cellStyles: true,
  });
  const files = unzipSync(new Uint8Array(output));
  files["xl/styles.xml"] = strToU8(stylesXml);
  files["xl/worksheets/sheet1.xml"] = strToU8(
    patchWorksheetXml(strFromU8(files["xl/worksheets/sheet1.xml"]), rowMeta),
  );
  saveWorkbookArray(zipSync(files), fileName);
}

function buildReportColumnDefs({ reportName, isSummary, columns }) {
  if (isBalanceSheetReport(reportName)) {
    const yearCols = Array.isArray(columns?.yearCols) ? columns.yearCols : [];
    const currentColumn =
      yearCols.find((column) => column.isCurrent) || yearCols[yearCols.length - 1] || null;

    return [
      {
        key: currentColumn?.key || "amount",
        label: "Total",
        type: "amount",
        getValue: (line) =>
          currentColumn?.key
            ? toNumber(line.amounts?.[currentColumn.key] ?? line.amount)
            : toNumber(line.amount),
      },
    ];
  }

  if (isProfitAndLossReport(reportName) && isSummary) {
    const pnlCols = Array.isArray(columns?.pnlCols) ? columns.pnlCols : [];
    if (pnlCols.length > 0) {
      return pnlCols.map((column) => ({
        key: column.key,
        label: column.label,
        type: "amount",
        getValue: (line) => toNumber(line.amounts?.[column.key]),
      }));
    }
  }

  if (isSummary) {
    return [
      {
        key: "amount",
        label: "Total",
        type: "amount",
        getValue: (line) => toNumber(line.amount),
      },
    ];
  }

  const comparativeColumns = buildComparativeColumns(reportName, columns).filter(
    (column) => column.type !== "label",
  );

  return comparativeColumns.length > 0
    ? comparativeColumns
    : [
      {
        key: "amount",
        label: "Total",
        type: "amount",
        getValue: (line) => toNumber(line.amount),
      },
    ];
}

function applyQuickBooksNumberFormats(sheet, {
  firstDataRowIndex,
  rowMeta,
  amountColumns,
  percentColumns = [],
  columnCount,
}) {
  rowMeta.forEach((meta, offset) => {
    const rowIndex = firstDataRowIndex + offset;
    const amountFormat = meta.isTotal
      ? '$#,##0.00;-$#,##0.00;-'
      : '#,##0.00;-#,##0.00;-';

    if (meta.isHeader || meta.isTotal) {
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        setCellStyle(sheet, rowIndex, columnIndex, {
          font: { bold: true, color: { rgb: "000000" } },
        });
      }
    }

    amountColumns.forEach((columnIndex) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && typeof cell.v === "number") cell.z = amountFormat;
      setCellStyle(sheet, rowIndex, columnIndex, {
        font: { color: { rgb: "000000" }, bold: meta.isHeader || meta.isTotal },
      });
    });

    percentColumns.forEach((columnIndex) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && typeof cell.v === "number") cell.z = '0.0%;-0.0%;-';
      setCellStyle(sheet, rowIndex, columnIndex, {
        font: { color: { rgb: "000000" }, bold: meta.isHeader || meta.isTotal },
      });
    });
  });
}

function buildQuickBooksStyleWorksheet({
  reportName,
  isSummary,
  reportRows,
  detailData,
  startDate,
  endDate,
  accountingMethod,
  createdOn,
}) {
  const isBalanceSheet = isBalanceSheetReport(reportName);
  const columnDefs = buildReportColumnDefs({
    reportName,
    isSummary,
    columns: detailData?.columns || {},
  });
  const includeComputedTotal =
    isProfitAndLossReport(reportName) &&
    columnDefs.filter((column) => column.type === "amount").length > 1 &&
    !columnDefs.some((column) => String(column.label || "").toLowerCase() === "total");
  const headers = [
    "",
    ...columnDefs.map((column) => column.label || ""),
    ...(includeComputedTotal ? ["Total"] : []),
  ];

  const { rows: bodyRows, meta: rowMeta } = addFormattedTreeRows(
    reportRows,
    (line, depth) => {
      const values = columnDefs.map((column) => {
        const value = column.getValue ? column.getValue(line) : toNumber(line.amount);
        return column.type === "percent" ? value : toNumber(value);
      });
      const total = includeComputedTotal
        ? values.reduce((sum, value, index) => {
          if (columnDefs[index]?.type !== "amount") return sum;
          return sum + toNumber(value);
        }, 0)
        : null;

      return [
        isBalanceSheet ? line.name || "" : indentLabel(line.name, depth),
        ...values,
        ...(includeComputedTotal ? [total] : []),
      ];
    },
  );

  const columnCount = headers.length;
  const footer = buildQuickBooksFooter(accountingMethod, createdOn);
  const title = isBalanceSheet ? "Balance Sheet" : "Profit and Loss";
  const periodText = isBalanceSheet
    ? buildBalanceSheetPeriodText(endDate)
    : buildProfitAndLossPeriodText(startDate, endDate);
  const blankRow = Array(columnCount).fill("");
  const sheetRows = [
    [title, ...Array(columnCount - 1).fill("")],
    blankRow,
    [periodText, ...Array(columnCount - 1).fill("")],
    blankRow,
    headers,
    ...bodyRows,
    blankRow,
    blankRow,
    blankRow,
    [footer, ...Array(columnCount - 1).fill("")],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const footerRowIndex = sheetRows.length - 1;

  for (let rowIndex = 0; rowIndex < sheetRows.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      setCellStyle(sheet, rowIndex, columnIndex, {
        font: { color: { rgb: "000000" } },
      });
    }
  }

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    setCellStyle(sheet, 0, columnIndex, {
      font: { bold: true, color: { rgb: "000000" } },
    });
    setCellStyle(sheet, 4, columnIndex, {
      font: { bold: true, color: { rgb: "000000" } },
    });
    setCellStyle(sheet, footerRowIndex, columnIndex, {
      font: { bold: true, color: { rgb: "000000" } },
    });
  }

  sheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: columnCount - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: columnCount - 1 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: columnCount - 1 } },
    { s: { r: footerRowIndex, c: 0 }, e: { r: footerRowIndex, c: columnCount - 1 } },
  ].filter((merge) => merge.e.c > merge.s.c);
  sheet["!cols"] = Array.from({ length: columnCount }, (_, index) => ({
    wch: index === 0 ? (isBalanceSheet ? 33 : 26) : 16,
  }));
  sheet["!freeze"] = { xSplit: 1, ySplit: 5 };

  const amountColumns = columnDefs
    .map((column, index) => (column.type === "amount" ? index + 1 : -1))
    .filter((index) => index >= 0);
  const percentColumns = columnDefs
    .map((column, index) => (column.type === "percent" ? index + 1 : -1))
    .filter((index) => index >= 0);
  if (includeComputedTotal) amountColumns.push(columnCount - 1);

  applyQuickBooksNumberFormats(sheet, {
    firstDataRowIndex: 5,
    rowMeta,
    amountColumns,
    percentColumns,
    columnCount,
  });

  return { sheet, rowMeta, columnCount };
}

function buildHeaderRows({
  title,
  subtitle,
  entityName,
  sourceLabel,
  createdOn,
  columnCount,
}) {
  const rows = [
    [entityName || "Company"],
    [title],
    [subtitle],
  ];

  if (sourceLabel) rows.push([`Source: ${sourceLabel}`]);
  if (createdOn) rows.push([`Created on: ${createdOn}`]);

  rows.push([]);

  const merges = rows
    .map((_, index) => ({
      s: { r: index, c: 0 },
      e: { r: index, c: Math.max(columnCount - 1, 0) },
    }))
    .filter((merge, index) => rows[index].length === 1 && columnCount > 1);

  return { rows, merges };
}

function addTreeRows(lines, buildRow, depth = 0, rows = []) {
  for (const line of Array.isArray(lines) ? lines : []) {
    rows.push(buildRow(line, depth));

    if (Array.isArray(line.children) && line.children.length > 0) {
      addTreeRows(line.children, buildRow, depth + 1, rows);
    }
  }

  return rows;
}

function calculateVariance(current, previous) {
  return toNumber(current) - toNumber(previous);
}

function calculateVariancePct(current, previous) {
  const previousValue = toNumber(previous);
  if (previousValue === 0) return 0;
  return calculateVariance(current, previous) / Math.abs(previousValue);
}

function buildSummaryWorksheetRows({ reportName, rows }) {
  const classificationLabel =
    reportName === "Cashflow" || reportName === "Cash Flow"
      ? "Cash Flow Classification"
      : "Accounting Classification";

  const headers = [classificationLabel, "Amount"];
  const body = addTreeRows(rows, (line, depth) => [
    `${"    ".repeat(depth)}${line.name || ""}`,
    toNumber(line.amount),
  ]);

  return { headers, body };
}

function buildComparativeColumns(reportName, columns = {}) {
  const yearCols = Array.isArray(columns.yearCols) ? columns.yearCols : [];
  const output = [
    {
      key: "name",
      label:
        reportName === "Cashflow" || reportName === "Cash Flow"
          ? "Cash Flow Classification"
          : "Accounting Classification",
      type: "label",
    },
  ];

  yearCols.forEach((col) => {
    output.push({
      key: col.key,
      label: col.label,
      type: "amount",
      getValue: (line) => toNumber(line.amounts?.[col.key]),
    });
  });

  if (Array.isArray(columns.changeCols) && columns.changeCols.length > 0) {
    columns.changeCols.forEach((col) => {
      output.push({
        key: col.key,
        label: col.label,
        type: "amount",
        getValue: (line) =>
          line.amounts?.[col.key] !== undefined
            ? toNumber(line.amounts?.[col.key])
            : calculateVariance(line.amounts?.[col.to], line.amounts?.[col.from]),
      });
    });

    output.push({
      key: "monthlyChange",
      label: columns.currentMonth
        ? `Monthly Change: ${columns.currentMonth}`
        : "Monthly Change",
      type: "amount",
      getValue: (line) => toNumber(line.amounts?.monthlyChange),
    });

    return output;
  }

  const ytd = columns.ytdComparison || {};
  if (ytd.currentKey) {
    output.push({
      key: "currentYtd",
      label: ytd.currentLabel || "Current YTD",
      type: "amount",
      getValue: (line) => toNumber(line.amounts?.[ytd.currentKey]),
    });
  }

  if (ytd.prevKey) {
    output.push({
      key: "prevYtd",
      label: ytd.prevLabel || "Prior YTD",
      type: "amount",
      getValue: (line) => toNumber(line.amounts?.[ytd.prevKey]),
    });
  }

  if (ytd.currentKey && ytd.prevKey) {
    output.push(
      {
        key: "ytdVariance",
        label: "YTD Change",
        type: "amount",
        getValue: (line) =>
          calculateVariance(line.amounts?.[ytd.currentKey], line.amounts?.[ytd.prevKey]),
      },
      {
        key: "ytdVariancePct",
        label: "YTD Change %",
        type: "percent",
        getValue: (line) =>
          calculateVariancePct(line.amounts?.[ytd.currentKey], line.amounts?.[ytd.prevKey]),
      },
    );
  }

  for (let index = 1; index < yearCols.length; index += 1) {
    const current = yearCols[index];
    const previous = yearCols[index - 1];
    output.push(
      {
        key: `${current.key}Variance`,
        label: `${current.label} Change`,
        type: "amount",
        getValue: (line) =>
          calculateVariance(line.amounts?.[current.key], line.amounts?.[previous.key]),
      },
      {
        key: `${current.key}VariancePct`,
        label: `${current.label} Change %`,
        type: "percent",
        getValue: (line) =>
          calculateVariancePct(line.amounts?.[current.key], line.amounts?.[previous.key]),
      },
    );
  }

  return output;
}

function buildComparativeWorksheetRows({ reportName, rows, columns }) {
  const columnDefs = buildComparativeColumns(reportName, columns);
  const headers = columnDefs.map((column) => column.label);
  const body = addTreeRows(rows, (line, depth) =>
    columnDefs.map((column) => {
      if (column.type === "label") return `${"    ".repeat(depth)}${line.name || ""}`;
      return column.getValue(line);
    }),
  );

  return { headers, body, columnDefs };
}

function applyWorksheetFormatting(sheet, {
  headerRowIndex,
  columnCount,
  rowCount,
  amountColumns = [],
  percentColumns = [],
  titleRowCount,
}) {
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  sheet["!cols"] = Array.from({ length: columnCount }, (_, index) => ({
    wch: index === 0 ? 42 : 16,
  }));
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: headerRowIndex, c: 0 },
      e: { r: Math.max(rowCount - 1, headerRowIndex), c: columnCount - 1 },
    }),
  };
  sheet["!freeze"] = { xSplit: 1, ySplit: headerRowIndex + 1 };

  for (let row = titleRowCount; row <= range.e.r; row += 1) {
    amountColumns.forEach((column) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell && typeof cell.v === "number") cell.z = '$#,##0.00;[Red]($#,##0.00);-';
    });

    percentColumns.forEach((column) => {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (cell && typeof cell.v === "number") cell.z = '0.0%;[Red](0.0%);-';
    });
  }
}

export function exportFinancialReportToExcel({
  reportName,
  viewType,
  entityName,
  subtitle,
  sourceLabel,
  createdOn,
  startDate,
  endDate,
  accountingMethod,
  summaryColumns,
  summaryRows,
  detailData,
  fileName,
}) {
  const isSummary = viewType === "Summary";
  const reportRows = isSummary
    ? Array.isArray(summaryRows)
      ? summaryRows
      : []
    : Array.isArray(detailData?.rows)
      ? detailData.rows
      : Array.isArray(detailData)
        ? detailData
        : [];

  if (reportRows.length === 0) {
    console.error("No data to export to Excel.");
    return;
  }

  if (isBalanceSheetReport(reportName) || isProfitAndLossReport(reportName)) {
    const workbook = XLSX.utils.book_new();
    const exportDetailData = isSummary && summaryColumns
      ? { columns: summaryColumns }
      : detailData;
    const { sheet, rowMeta, columnCount } = buildQuickBooksStyleWorksheet({
      reportName,
      isSummary,
      reportRows,
      detailData: exportDetailData,
      startDate,
      endDate,
      accountingMethod,
      createdOn,
    });
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
    if (isBalanceSheetReport(reportName)) {
      writeStyledWorkbook({
        workbook,
        fileName,
        rowMeta,
        stylesXml: BALANCE_SHEET_STYLES_XML,
        patchWorksheetXml: patchBalanceSheetWorksheetXml,
      });
      return;
    }
    if (isProfitAndLossReport(reportName)) {
      writeStyledWorkbook({
        workbook,
        fileName,
        rowMeta,
        stylesXml: PROFIT_AND_LOSS_STYLES_XML,
        patchWorksheetXml: (xml, meta) => patchProfitAndLossWorksheetXml(
          xml,
          meta,
          columnCount,
        ),
      });
      return;
    }
    XLSX.writeFile(workbook, `${fileName || "report"}.xlsx`);
    return;
  }

  const { headers, body, columnDefs } = isSummary
    ? buildSummaryWorksheetRows({ reportName, rows: reportRows })
    : buildComparativeWorksheetRows({
      reportName,
      rows: reportRows,
      columns: detailData?.columns || {},
    });

  const title = isSummary
    ? `${reportName} Statement`
    : `${reportName} Comparative Statement`;
  const columnCount = headers.length;
  const { rows: headerRows, merges } = buildHeaderRows({
    title,
    subtitle,
    entityName,
    sourceLabel,
    createdOn,
    columnCount,
  });
  const sheetRows = [...headerRows, headers, ...body];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const headerRowIndex = headerRows.length;
  const amountColumns = isSummary
    ? [1]
    : columnDefs
      .map((column, index) => (column.type === "amount" ? index : -1))
      .filter((index) => index >= 0);
  const percentColumns = isSummary
    ? []
    : columnDefs
      .map((column, index) => (column.type === "percent" ? index : -1))
      .filter((index) => index >= 0);

  sheet["!merges"] = merges;
  applyWorksheetFormatting(sheet, {
    headerRowIndex,
    columnCount,
    rowCount: sheetRows.length,
    amountColumns,
    percentColumns,
    titleRowCount: headerRows.length + 1,
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, formatSheetName(reportName));
  XLSX.writeFile(workbook, `${fileName || "report"}.xlsx`);
}


export function exportToExcel(title, subtitle, rows, fileName) {
  if (!rows || rows.length === 0) {
    console.error("No data to export to Excel.");
    return;
  }

  const workbook = XLSX.utils.book_new();
  const headers = Object.keys(rows[0] || {});
  const sheet = XLSX.utils.aoa_to_sheet([[title], [subtitle], [], headers]);

  XLSX.utils.sheet_add_json(sheet, rows, {
    origin: "A5",
    skipHeader: true,
  });

  // Set column widths
  const colWidths = headers.map((h) => ({ wch: Math.max(h.length, 15) }));
  sheet["!cols"] = colWidths;

  XLSX.utils.book_append_sheet(workbook, sheet, "Report");
  XLSX.writeFile(workbook, `${fileName || "report"}.xlsx`);
}

/**
 * Exports a DOM element to a high-resolution PDF using html2canvas and jsPDF.
 */
export async function exportToPDF(elementId, fileName) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error(`Element with id "${elementId}" not found.`);
    return;
  }

  try {
    // Hide scrollbars before capture
    const originalOverflow = element.style.overflow;
    element.style.overflow = "visible";

    // Capture the element
    const canvas = await html2canvas(element, {
      scale: 2, // High resolution
      useCORS: true, // Handle cross-origin images
      logging: false,
      backgroundColor: "#ffffff",
      windowWidth: element.scrollWidth,
      windowHeight: element.scrollHeight,
    });

    // Restore original style
    element.style.overflow = originalOverflow;

    const imgData = canvas.toDataURL("image/png");
    
    // Calculate dimensions
    const pdfWidth = 595.28; // A4 width in pts
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    
    // Create PDF with dynamic height to accommodate long reports on a single page
    // Or standard A4 height if it fits
    const orientation = canvas.width > canvas.height ? "l" : "p";
    const pdf = new jsPDF(orientation, "pt", [pdfWidth, Math.max(pdfHeight, 841.89)]);

    pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight, undefined, "FAST");
    pdf.save(`${fileName || "report"}.pdf`);
  } catch (error) {
    console.error("PDF export failed:", error);
    throw error;
  }
}
