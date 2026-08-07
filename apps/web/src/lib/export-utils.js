import * as XLSX from "xlsx";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";


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
