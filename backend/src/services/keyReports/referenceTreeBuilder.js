function normName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function rowName(row) {
  return String(row?.name || row?.account_name || row?.accountName || "").trim();
}

function rowAmount(row) {
  if (Object.prototype.hasOwnProperty.call(row || {}, "value")) return row.value;
  if (Object.prototype.hasOwnProperty.call(row || {}, "amount")) return row.amount;
  return null;
}

function isHeading(row) {
  const type = String(row?.node_type || row?.row_type || "").toLowerCase();
  return row?.is_header || row?.is_section_header || type === "heading" ||
    type === "hierarchy_section" || type === "hierarchy_group";
}

function isTotal(row) {
  const name = rowName(row);
  return Boolean(row?.is_total) || /^total\s+for\s+/i.test(name) || /^total\s+/i.test(name);
}

function unwrapTree(input) {
  if (input?.data?.nodeType === "REPORT") return input.data;
  if (input?.nodeType === "REPORT") return input;
  return null;
}

function totalName(label) {
  const name = String(label || "").trim();
  if (!name) return "";
  if (/^total\s+for\s+/i.test(name)) return name;
  if (/^total\s+/i.test(name)) return name.replace(/^total\s+/i, "Total for ");
  return `Total for ${name}`;
}

function stripTotalPrefix(label) {
  return String(label || "").trim().replace(/^total\s+for\s+/i, "").replace(/^total\s+/i, "");
}

function normalizedPath(path) {
  return (path || []).map(stripTotalPrefix).filter(Boolean);
}

function ensurePath(parent, path, nodeType = "TOTAL") {
  let cursor = parent;
  for (const label of path || []) {
    const name = String(label || "").trim();
    if (!name) continue;
    let child = cursor.children.find((c) => normName(c.name) === normName(name) && c.nodeType !== "ACCOUNT");
    if (!child) {
      child = { name, nodeType, children: [] };
      cursor.children.push(child);
    }
    cursor = child;
  }
  return cursor;
}

function ensureTotalPath(parent, path) {
  return ensurePath(parent, normalizedPath(path).map(totalName), "TOTAL");
}

function findTotalNode(root, sectionName) {
  const target = normName(totalName(sectionName));
  const stack = [...(root.children || [])];
  while (stack.length) {
    const node = stack.shift();
    if (node.nodeType === "TOTAL" && normName(node.name) === target) return node;
    stack.push(...(node.children || []));
  }
  return null;
}

function buildBalanceSheetTreeFromData({ reportName, rows }) {
  const existing = unwrapTree(rows);
  if (existing) return existing;
  const root = { name: reportName || "Balance Sheet", nodeType: "REPORT", children: [] };
  for (const row of rows || []) {
    const name = rowName(row);
    if (!name) continue;
    const amount = rowAmount(row);
    if (isHeading(row) && !isTotal(row)) {
      ensureTotalPath(root, [...(row.parent_path || []), name]);
      continue;
    }
    if (isTotal(row)) {
      const sectionName = stripTotalPrefix(name);
      const totalPath = row.parent_path?.length ? [...row.parent_path, sectionName] : [sectionName];
      const totalNode = ensureTotalPath(root, totalPath);
      totalNode.name = totalName(sectionName);
      totalNode.value = amount;
      continue;
    }
    const parent = ensureTotalPath(root, row.parent_path || []);
    parent.children.push({
      name,
      nodeType: "ACCOUNT",
      value: amount,
      children: [],
    });
  }
  return root;
}

function valuesForRow(row, periodKeys) {
  if (row?.values && typeof row.values === "object") {
    const values = {};
    for (const key of periodKeys || Object.keys(row.values)) values[key] = row.values[key] ?? null;
    return values;
  }
  const key = row?.fiscal_year ? `FY ${row.fiscal_year}` : "Total";
  return { [key]: rowAmount(row) };
}

function buildProfitLossTreeFromData({ reportName, periodKeys, rows }) {
  const existing = unwrapTree(rows);
  if (existing) return existing;
  const root = { name: reportName || "Profit and Loss", nodeType: "REPORT", children: [] };
  const netIncome = { name: "Net Income", nodeType: "CALCULATED_TOTAL", values: {}, relationship: "ADD", children: [] };
  const netOperatingIncome = { name: "Net Operating Income", nodeType: "CALCULATED_TOTAL", values: {}, relationship: "ADD", children: [] };
  const grossProfit = { name: "Gross Profit", nodeType: "CALCULATED_TOTAL", values: {}, relationship: "ADD", children: [] };
  const netOtherIncome = { name: "Net Other Income", nodeType: "CALCULATED_TOTAL", values: {}, relationship: "ADD", children: [] };
  root.children.push(netIncome);
  netIncome.children.push(netOperatingIncome, netOtherIncome);
  netOperatingIncome.children.push(grossProfit);

  const sectionRoot = (row) => {
    const section = String(row?.section || "").toLowerCase();
    if (section === "other_income" || section === "other_expense") return netOtherIncome;
    return grossProfit;
  };

  for (const row of rows || []) {
    const name = rowName(row);
    if (!name) continue;
    if (isHeading(row) && !isTotal(row)) continue;
    const section = String(row?.section || "").toLowerCase();
    const relationship = String(row?.section || "").toLowerCase().includes("expense") ||
      String(row?.section || "").toLowerCase() === "cost_of_sales"
      ? "SUBTRACT"
      : "ADD";
    if (isTotal(row)) {
      const sectionName = stripTotalPrefix(name);
      const parent = relationship === "SUBTRACT" && section !== "other_expense"
        ? netOperatingIncome
        : sectionRoot(row);
      const totalNode = findTotalNode(parent, sectionName) || ensureTotalPath(parent, [sectionName]);
      totalNode.name = totalName(sectionName);
      totalNode.nodeType = "TOTAL";
      totalNode.values = valuesForRow(row, periodKeys);
      totalNode.relationship = relationship;
      continue;
    }
    const path = normalizedPath(row.parent_path || []);
    const sectionPath = path.length ? [path[0]] : [row?.section && relationship === "SUBTRACT" ? "Expenses" : "Income"];
    const parentRoot = relationship === "SUBTRACT" && section !== "other_expense"
      ? netOperatingIncome
      : sectionRoot(row);
    const parent = ensureTotalPath(parentRoot, sectionPath);
    parent.relationship = relationship === "SUBTRACT" ? "SUBTRACT" : "ADD";
    parent.children.push({
      name,
      nodeType: String(row?.node_type || "").toLowerCase() === "subtotal" ? "CALCULATED_TOTAL" : "ACCOUNT",
      values: valuesForRow(row, periodKeys),
      relationship: "ADD",
      children: [],
    });
  }
  return root;
}

module.exports = {
  buildBalanceSheetTreeFromData,
  buildProfitLossTreeFromData,
};
