import * as XLSX from "xlsx";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

function getColumnWidth(value) {
  if (value == null) return 15;
  return Math.max(String(value).length, 15);
}

function buildExcelSheet(title, subtitle, rows) {
  const headers = Object.keys(rows[0] || {});
  const sheet = XLSX.utils.aoa_to_sheet([
    [title],
    [subtitle],
    [],
    headers,
  ]);

  XLSX.utils.sheet_add_json(sheet, rows, {
    origin: "A5",
    skipHeader: true,
  });

  sheet["!cols"] = headers.map((header) => ({
    wch: rows.reduce(
      (maxWidth, row) => Math.max(maxWidth, getColumnWidth(row?.[header])),
      getColumnWidth(header),
    ),
  }));

  return sheet;
}

function sanitizeSheetName(value, fallback = "Report") {
  const cleaned = String(value || fallback)
    .replace(/[\\/*?:[\]]+/g, " ")
    .trim();

  return (cleaned || fallback).slice(0, 31);
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "export";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

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

export function createExcelBlob(title, subtitle, rows) {
  if (!rows || rows.length === 0) {
    console.error("No data to export to Excel.");
    return null;
  }

  const workbook = XLSX.utils.book_new();
  const sheet = buildExcelSheet(title, subtitle, rows);
  XLSX.utils.book_append_sheet(workbook, sheet, "Report");
  const content = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  return new Blob([content], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function createWorkbookBlob(sheets) {
  const workbook = XLSX.utils.book_new();
  let appended = false;

  for (const config of Array.isArray(sheets) ? sheets : []) {
    const rows = Array.isArray(config?.rows) ? config.rows : [];
    if (!rows.length) continue;

    const sheet = buildExcelSheet(
      config.title || config.name || "Report",
      config.subtitle || "",
      rows,
    );

    XLSX.utils.book_append_sheet(
      workbook,
      sheet,
      sanitizeSheetName(config.name || config.title || "Report"),
    );
    appended = true;
  }

  if (!appended) {
    console.error("No data to export to Excel workbook.");
    return null;
  }

  const content = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  return new Blob([content], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function exportToExcel(title, subtitle, rows, fileName) {
  const blob = createExcelBlob(title, subtitle, rows);
  if (!blob) return;
  downloadBlob(blob, `${fileName || "report"}.xlsx`);
}

/**
 * Exports a DOM element to a high-resolution PDF using html2canvas and jsPDF.
 */
export async function createPdfBlob(elementId) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error(`Element with id "${elementId}" not found.`);
    return null;
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
    return pdf.output("blob");
  } catch (error) {
    console.error("PDF export failed:", error);
    throw error;
  }
}

export async function exportToPDF(elementId, fileName) {
  const blob = await createPdfBlob(elementId);
  if (!blob) return;
  downloadBlob(blob, `${fileName || "report"}.pdf`);
}
