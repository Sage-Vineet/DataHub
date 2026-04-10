import * as XLSX from "xlsx";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

export function flattenDetailData(data) {
  const rows = [];

  for (const group of data?.groups || []) {
    for (const account of group.accounts || []) {
      for (const transaction of account.transactions || []) {
        rows.push({
          Date: transaction.date || "",
          Type: transaction.type || "",
          Num: transaction.num || "",
          Name: transaction.name || "",
          Memo: transaction.memo || "",
          Split: transaction.split || "",
          Amount: Number(transaction.amount || 0),
          Balance: Number(transaction.balance || 0),
        });
      }
    }
  }

  return rows;
}

function normalizeRawHeader(column, index) {
  const title = String(column?.ColTitle || "").trim();
  if (title) return title;

  const type = String(column?.ColType || "").trim();
  if (type === "Money") return "Amount";
  if (type === "Account") return "Account";
  if (type) return type;

  return `Column ${index + 1}`;
}

function findRawColumnCount(rows = []) {
  let max = 0;

  for (const row of rows) {
    max = Math.max(
      max,
      row?.Header?.ColData?.length || 0,
      row?.ColData?.length || 0,
      row?.Summary?.ColData?.length || 0,
      findRawColumnCount(row?.Rows?.Row || []),
    );
  }

  return max;
}

function buildRawRowValues(columns = [], columnCount, depth = 0) {
  const values = Array.from({ length: columnCount }, (_, index) =>
    columns[index]?.value ?? "",
  );

  const firstValueIndex = values.findIndex(
    (value) => String(value || "").trim() !== "",
  );

  if (firstValueIndex >= 0 && depth > 0) {
    values[firstValueIndex] = `${"\u00a0\u00a0".repeat(depth)}${values[firstValueIndex]}`;
  }

  return values;
}

function collectRawReportRows(rows = [], columnCount, depth = 0, output = []) {
  for (const row of rows) {
    if (row?.Header?.ColData?.length) {
      output.push(buildRawRowValues(row.Header.ColData, columnCount, depth));
    }

    if (row?.ColData?.length) {
      output.push(buildRawRowValues(row.ColData, columnCount, depth));
    }

    if (Array.isArray(row?.Rows?.Row) && row.Rows.Row.length > 0) {
      collectRawReportRows(row.Rows.Row, columnCount, depth + 1, output);
    }

    if (row?.Summary?.ColData?.length) {
      output.push(buildRawRowValues(row.Summary.ColData, columnCount, depth));
    }
  }

  return output;
}

export function flattenRawReportData(payload) {
  const columns = payload?.Columns?.Column || [];
  const rows = payload?.Rows?.Row || [];
  const columnCount = Math.max(columns.length, findRawColumnCount(rows));
  const headers = Array.from({ length: columnCount }, (_, index) =>
    normalizeRawHeader(columns[index], index),
  );

  return {
    headers,
    rows: collectRawReportRows(rows, columnCount),
  };
}

export function exportToExcel(title, subtitle, rows, fileName) {
  const workbook = XLSX.utils.book_new();
  const headers = Object.keys(rows[0] || {});
  const sheet = XLSX.utils.aoa_to_sheet([[title], [subtitle], [], headers]);

  if (rows.length > 0) {
    XLSX.utils.sheet_add_json(sheet, rows, {
      origin: "A5",
      skipHeader: true,
    });
  }

  XLSX.utils.book_append_sheet(workbook, sheet, "Report");
  XLSX.writeFile(workbook, `${fileName || "report"}.xlsx`);
}

export function exportToPDF(elementId, fileName) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error(`Element with id "${elementId}" not found.`);
    return;
  }

  // Create a hidden iframe
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");

  document.body.appendChild(iframe);

  const printDocument = iframe.contentWindow?.document;
  if (!printDocument) {
    document.body.removeChild(iframe);
    throw new Error("Unable to create print document.");
  }

  // Get all styles from the main document
  const styles = Array.from(document.querySelectorAll("style, link[rel='stylesheet']"))
    .map((style) => style.outerHTML)
    .join("\n");

  // Get the content to print
  // We use outerHTML to capture the container's own classes and styles
  const contentHtml = element.outerHTML;

  printDocument.open();
  printDocument.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${fileName || "Report"}</title>
        ${styles}
        <style>
          body { 
            background: white !important; 
            margin: 0 !important; 
            padding: 0 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            font-family: 'Inter', sans-serif;
          }
          /* Ensure the content fits the page width and looks like the preview */
          #${elementId} {
            width: 190mm !important; /* A4 width minus 10mm margins on both sides */
            max-width: none !important;
            box-shadow: none !important;
            border: none !important;
            border-radius: 0 !important;
            margin: 0 auto !important;
            padding: 0 !important;
            background: white !important;
            display: block !important;
            visibility: visible !important;
            overflow: visible !important;
          }
          /* Remove the outer background and padding from the report components */
          #${elementId} > div {
            background: transparent !important;
            padding: 0 !important;
            overflow: visible !important;
            min-height: auto !important;
          }
          /* Ensure the card inside fits well */
          #${elementId} .card-base, 
          #${elementId} .max-w-4xl, 
          #${elementId} .max-w-6xl {
            max-width: 100% !important;
            width: 100% !important;
            box-shadow: none !important;
            border: none !important;
          }
          /* Hide interactive elements that shouldn't be in the PDF */
          button, .no-print, [role="button"] {
            display: none !important;
          }
          /* Ensure SVGs (like Lucide icons) print correctly */
          svg {
            max-width: 100%;
          }
          /* Table optimization for PDF */
          table {
            width: 100% !important;
            table-layout: auto !important;
            border-collapse: collapse !important;
            font-size: 10px !important;
          }
          th {
            font-size: 10px !important;
            padding: 8px 4px !important;
            background-color: #1a1a1a !important;
            color: white !important;
            -webkit-print-color-adjust: exact !important;
          }
          td {
            font-size: 10px !important;
            padding: 6px 4px !important;
            word-break: break-word !important;
          }
          /* Ensure specific text alignments stay intact */
          .text-right { text-align: right !important; }
          .text-left { text-align: left !important; }
          .text-center { text-align: center !important; }
          
          /* Force page breaks if needed */
          tr {
            page-break-inside: avoid;
          }
          /* Remove large paddings for print */
          .py-12, .p-10, .p-8 {
            padding-top: 20px !important;
            padding-bottom: 20px !important;
          }
          /* Set page size to A4 */
          @page {
            size: A4;
            margin: 10mm;
          }
        </style>
      </head>
      <body>
        ${contentHtml}
      </body>
    </html>
  `);
  printDocument.close();

  // Wait for resources (fonts, images) to load
  iframe.contentWindow.onload = () => {
    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      
      // Cleanup
      setTimeout(() => {
        if (iframe.parentNode) {
          document.body.removeChild(iframe);
        }
      }, 1000);
    }, 500);
  };
}
