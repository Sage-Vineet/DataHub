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

export function exportToPDF(title, subtitle, headers, rows, fileName) {
  const tableRows = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td>${escapeHtml(cell)}</td>`)
          .join("")}</tr>`,
    )
    .join("");

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";

  document.body.appendChild(iframe);

  const printDocument =
    iframe.contentWindow?.document || iframe.contentDocument;

  if (!printDocument) {
    document.body.removeChild(iframe);
    throw new Error("Unable to create print document.");
  }

  printDocument.open();
  printDocument.write(`
    <html>
      <head>
        <title>${escapeHtml(fileName || title)}</title>
        <style>
          @page { size: auto; margin: 16mm; }
          body { font-family: Arial, sans-serif; padding: 24px; color: #111827; }
          h1 { margin: 0 0 8px; font-size: 24px; }
          p { margin: 0 0 20px; color: #6b7280; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
          th { background: #f3f4f6; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(subtitle)}</p>
        <table>
          <thead>
            <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </body>
    </html>
  `);
  printDocument.close();

  const printWindow = iframe.contentWindow;
  if (!printWindow) {
    document.body.removeChild(iframe);
    throw new Error("Unable to access print window.");
  }

  const cleanup = () => {
    window.setTimeout(() => {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }, 1000);
  };

  printWindow.onafterprint = cleanup;
  window.setTimeout(() => {
    printWindow.focus();
    printWindow.print();
    cleanup();
  }, 250);
}
