export function exportToCSV(data, headers, fileName, mapRow) {
  const rows = Array.isArray(data) ? data : [];
  const body = rows.map((item) => (typeof mapRow === "function" ? mapRow(item) : item));
  const csv = [headers, ...body]
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName || "export"}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
