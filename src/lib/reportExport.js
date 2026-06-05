import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import html2canvas from "html2canvas";

// Turn a report title into a safe, readable file name.
function sanitizeFileName(name) {
  return (
    String(name || "report")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "report"
  );
}

function getReportRoot(elementId) {
  const root = document.getElementById(elementId);
  if (!root) throw new Error("Report content not found — generate a report first.");
  return root;
}

/**
 * Export the currently-rendered report table to an .xlsx workbook.
 * Reads the live <table> DOM (SheetJS table_to_book), so it captures exactly
 * what is on screen — including any expanded vendor/customer rows. Works for
 * every report type that renders an HTML table.
 */
export function exportReportToExcel(elementId, fileName = "report") {
  const root = getReportRoot(elementId);
  const table = root.querySelector("table");
  if (!table) throw new Error("No table found in the report to export.");
  const workbook = XLSX.utils.table_to_book(table, { sheet: "Report", raw: false });
  XLSX.writeFile(workbook, `${sanitizeFileName(fileName)}.xlsx`);
}

/**
 * Export the currently-rendered report to a PDF by rasterizing the DOM.
 * Internal scroll containers (e.g. the frozen-pane table) are temporarily
 * un-clipped so the FULL report is captured, not just the visible viewport.
 */
export async function exportReportToPdf(elementId, fileName = "report") {
  const root = getReportRoot(elementId);

  // Temporarily neutralize any descendant that clips/scrolls so html2canvas
  // captures the entire report height, then restore the original inline styles.
  const clipped = [root, ...root.querySelectorAll("*")].filter((node) => {
    const s = window.getComputedStyle(node);
    return (
      s.overflowY === "auto" ||
      s.overflowY === "scroll" ||
      s.overflowX === "auto" ||
      s.overflowX === "scroll" ||
      (s.maxHeight && s.maxHeight !== "none")
    );
  });
  const saved = clipped.map((node) => ({ node, cssText: node.style.cssText }));
  clipped.forEach((node) => {
    node.style.overflow = "visible";
    node.style.maxHeight = "none";
  });

  try {
    const canvas = await html2canvas(root, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      windowWidth: root.scrollWidth,
    });

    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    const imgData = canvas.toDataURL("image/png");

    let heightLeft = imgHeight;
    let position = 0;
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
      position -= pageHeight;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    pdf.save(`${sanitizeFileName(fileName)}.pdf`);
  } finally {
    saved.forEach(({ node, cssText }) => {
      node.style.cssText = cssText;
    });
  }
}
