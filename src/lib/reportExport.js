import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";

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

// FrozenPaneTable (the shared sticky-header table primitive) renders the
// header and body as two SIBLING <table> elements — one with a <thead> and
// no rows, one with a <tbody> and no header row — so the header can stay
// genuinely sticky to the page instead of a scroll-container hack (see
// FrozenPaneTable.jsx for why). A naive `querySelector("table")` only ever
// finds the first one, silently exporting either headers with zero data
// rows or data with no headers. Querying <thead>/<tbody> directly against
// the report root sidesteps how many <table> elements they're split across
// — this works whether they're two tables (FrozenPaneTable) or one
// (any older single-table report component).
function buildExportTable(root) {
  const thead = root.querySelector("thead");
  const tbody = root.querySelector("tbody");
  if (!thead && !tbody) return null;

  const combined = document.createElement("table");
  if (thead) combined.appendChild(thead.cloneNode(true));
  if (tbody) combined.appendChild(tbody.cloneNode(true));
  return combined;
}

export function exportReportToExcel(elementId, fileName = "report") {
  const root = getReportRoot(elementId);
  const table = buildExportTable(root);
  if (!table) throw new Error("No table found in the report to export.");
  const workbook = XLSX.utils.table_to_book(table, { sheet: "Report", raw: false });
  XLSX.writeFile(workbook, `${sanitizeFileName(fileName)}.xlsx`);
}

function fmtDate(iso) {
  if (!iso || iso === "1970-01-01") return "";
  try {
    const [y, m, d] = iso.split("-").map(Number);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[m - 1]} ${d}, ${y}`;
  } catch {
    return iso;
  }
}

function parseReportTable(root) {
  const thead = root.querySelector("thead");
  const tbody = root.querySelector("tbody");
  if (!thead && !tbody) return { colHeaders: [], rows: [] };

  const thCells = [...(thead?.querySelectorAll("th") ?? [])];
  const colHeaders = thCells.map(th => th.textContent.trim().replace(/\s+/g, " "));

  const rows = [];
  (tbody ? [...tbody.querySelectorAll("tr")] : []).forEach(tr => {
    const cells = [...tr.querySelectorAll("td")];
    if (!cells.length) return;

    const firstCell = cells[0];

    const spacerWrap = firstCell.querySelector(".flex.shrink-0");
    let depth = 0;
    if (spacerWrap) {
      depth = [...spacerWrap.querySelectorAll(".w-6")].length;
    }

    const spans = [...firstCell.querySelectorAll("span")];
    const name = (spans[spans.length - 1]?.textContent ?? firstCell.textContent)
      .trim()
      .replace(/\s+/g, " ");

    const values = cells.slice(1).map(td => td.textContent.trim().replace(/\s+/g, " "));
    const isBold = (tr.className ?? "").includes("font-semibold");

    rows.push({ name, values, depth, isBold });
  });

  return { colHeaders, rows };
}

/**
 * Auto-select orientation and scale all measurements to the number of columns.
 *
 *  ≤ 3 cols  → portrait,   9pt font, 17pt row
 *  4–8 cols  → landscape,  9pt font, 17pt row
 *  9+ cols   → landscape,  8pt font, 16pt row, tighter margins
 */
function computeLayout(nValCols) {
  const isCompact = nValCols >= 9;
  const usePortrait = nValCols <= 3;

  // Page geometry
  const PORTRAIT_PW  = 595.28, PORTRAIT_PH  = 841.89;
  const LANDSCAPE_PW = 841.89, LANDSCAPE_PH = 595.28;

  const rawPW = usePortrait ? PORTRAIT_PW : LANDSCAPE_PW;
  const rawPH = usePortrait ? PORTRAIT_PH : LANDSCAPE_PH;

  // Margins — tighter on compact wide reports
  const ML = isCompact ? 24 : 36;
  const MR = isCompact ? 24 : 36;
  const MT = isCompact ? 38 : 45;
  const MB = isCompact ? 38 : 45;
  const CW = rawPW - ML - MR;

  // Column widths — name column always gets at least 150pt
  const MIN_NAME_W  = 150;
  const CELL_PAD    = 3;   // padding on each side inside a value cell
  const rawValW = (CW - MIN_NAME_W) / nValCols;
  const VAL_W  = Math.max(40, rawValW);
  const NAME_W = Math.max(MIN_NAME_W, CW - nValCols * VAL_W);

  const ROW_H     = isCompact ? 15 : 17;
  const DATA_FONT = isCompact ? 8  : 9;
  const HDR_FONT  = isCompact ? 7  : 8;

  return {
    orientation: usePortrait ? "portrait" : "landscape",
    PW: rawPW, PH: rawPH,
    ML, MR, MT, MB, CW,
    VAL_W, NAME_W,
    CELL_PAD,
    ROW_H, DATA_FONT, HDR_FONT,
  };
}

export async function exportReportToPdf(elementId, fileName = "report", meta = {}) {
  const root = getReportRoot(elementId);
  const { colHeaders, rows } = parseReportTable(root);
  if (!rows.length) throw new Error("No report data found to export.");

  const { entityName = "", reportType = "", accountingMethod = "" } = meta;

  const valueCols = colHeaders.slice(1);
  const nValCols  = Math.max(1, valueCols.length);

  const {
    orientation, PW, PH,
    ML, MR, MT, MB, CW,
    VAL_W, NAME_W, CELL_PAD,
    ROW_H, DATA_FONT, HDR_FONT,
  } = computeLayout(nValCols);

  const doc = new jsPDF({ orientation, unit: "pt", format: "a4" });

  // x-coordinate of the right edge of value column i (0-based)
  const valColRight = (i) => PW - MR - (nValCols - 1 - i) * VAL_W;
  // x-coordinate of the left edge of value column i
  const valColLeft  = (i) => valColRight(i) - VAL_W;
  // x of the separator between name col and first val col
  const nameSepX    = ML + NAME_W;

  // ── Draw vertical grid lines for a row band ──────────────────────
  const drawVerticalLines = (top, bottom) => {
    doc.setDrawColor(210, 210, 210);
    doc.setLineWidth(0.4);
    // Separator after name column
    doc.line(nameSepX, top, nameSepX, bottom);
    // Separator after each value column (except the last)
    for (let i = 0; i < nValCols - 1; i++) {
      const x = valColRight(i);
      doc.line(x, top, x, bottom);
    }
  };

  let y = MT;

  // ── Centered header ──────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(10, 10, 10);
  doc.text(entityName, PW / 2, y, { align: "center" });
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.text(reportType, PW / 2, y, { align: "center" });
  y += 14;

  y += 5;
  doc.setDrawColor(190, 190, 190);
  doc.setLineWidth(0.5);
  doc.line(ML, y, PW - MR, y);
  y += 11;

  // ── Column header row ────────────────────────────────────────────
  const drawColHeaders = () => {
    const hdrTop    = y - ROW_H + 3;
    const hdrBottom = y + 6;

    // Header background
    doc.setFillColor(237, 239, 242);
    doc.rect(ML, hdrTop, CW, hdrBottom - hdrTop, "F");

    // Column header text
    doc.setFont("helvetica", "bold");
    doc.setFontSize(HDR_FONT);
    doc.setTextColor(80, 80, 80);

    if (colHeaders[0]) {
      doc.text(colHeaders[0], ML + 4, y);
    }
    valueCols.forEach((col, i) => {
      doc.text(col, valColRight(i) - CELL_PAD, y, { align: "right" });
    });

    y += 4;
    doc.setDrawColor(30, 30, 30);
    doc.setLineWidth(1);
    doc.line(ML, y, PW - MR, y);

    // Vertical separators on header
    drawVerticalLines(hdrTop, y);

    y += ROW_H - 4;
  };

  drawColHeaders();

  // ── Data rows ─────────────────────────────────────────────────────
  let rowIndex = 0;

  for (const row of rows) {
    // Page break
    if (y + ROW_H > PH - MB) {
      doc.addPage();
      y = MT;
      rowIndex = 0;
      drawColHeaders();
    }

    const rowTop    = y - ROW_H + 5;
    const rowBottom = y + 4;

    // Row background:
    //   bold rows  → medium gray
    //   even rows  → very light gray (zebra)
    //   odd rows   → white
    if (row.isBold) {
      doc.setFillColor(232, 234, 237);
      doc.rect(ML, rowTop, CW, rowBottom - rowTop, "F");
    } else if (rowIndex % 2 === 1) {
      doc.setFillColor(248, 249, 251);
      doc.rect(ML, rowTop, CW, rowBottom - rowTop, "F");
    }

    // Account / description name
    const indent = row.depth * 10;
    const maxW   = NAME_W - indent - 8;
    doc.setFont("helvetica", row.isBold ? "bold" : "normal");
    doc.setFontSize(DATA_FONT);
    doc.setTextColor(row.isBold ? 15 : 45);

    const label = doc.splitTextToSize(row.name, maxW)[0] ?? row.name;
    doc.text(label, ML + indent + 4, y);

    // Value cells — right-aligned with padding, clamped to column bounds
    row.values.forEach((val, i) => {
      if (!val || val === "") return;
      const xRight = valColRight(i) - CELL_PAD;
      const neg = val.startsWith("(") || (val.startsWith("-") && val.length > 1);
      doc.setTextColor(
        neg ? 180 : (row.isBold ? 15 : 45),
        neg ? 30  : (row.isBold ? 15 : 45),
        neg ? 30  : (row.isBold ? 15 : 45),
      );
      doc.text(val, xRight, y, { align: "right" });
    });

    // Thin horizontal row separator
    doc.setDrawColor(218, 220, 224);
    doc.setLineWidth(0.3);
    doc.line(ML, rowBottom, PW - MR, rowBottom);

    // Vertical column separators for this row
    drawVerticalLines(rowTop, rowBottom);

    y += ROW_H;
    if (!row.isBold) rowIndex++;
  }

  // ── Footers ───────────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages();
  const now = new Date();
  const nowStr =
    now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) +
    "  " +
    now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    const fy = PH - 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(150, 150, 150);
    if (accountingMethod) {
      doc.text(`${accountingMethod} Basis  ${nowStr}`, ML, fy);
    }
    doc.text(`${p}/${totalPages}`, PW - MR, fy, { align: "right" });
  }

  doc.save(`${sanitizeFileName(fileName)}.pdf`);
}
