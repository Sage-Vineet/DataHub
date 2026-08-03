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
  // The same account legitimately recurs across fiscal years and across
  // multiple uploaded Balance Sheets. It must become exactly ONE tree node, so
  // the first placement wins and later occurrences are skipped. Callers order
  // rows so the authoritative (reference/ending) year is processed first --
  // see keyReportSyncService's balanceSheetRowsForTree. Without this, feeding
  // several years' rows would push duplicate leaves for one account, leaving
  // its hierarchy ambiguous.
  const placedAccounts = new Set();
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
    // One tree node per distinct account, first placement wins (see
    // placedAccounts above). Identity is the normalized account name -- the
    // same key pickDocHierarchy/normName use to look accounts up, so a name
    // that would resolve to one COA leaf resolves to one tree node here too.
    const accountKey = normName(name);
    if (placedAccounts.has(accountKey)) continue;
    placedAccounts.add(accountKey);
    const parent = ensureTotalPath(root, row.parent_path || []);
    parent.children.push({
      name,
      nodeType: "ACCOUNT",
      value: amount,
      children: [],
      // The row's OWN document-derived section, carried verbatim onto the node
      // (raw string -- the consumer maps it with the single existing
      // vocabulary mapper, so there is no duplicated section taxonomy here).
      //
      // CONFIRMED ROOT CAUSE this fixes: when a Balance Sheet row has no
      // parent_path (the extractor captured no ancestry for it -- e.g. a
      // document whose accounts carry no readable indentation under their
      // section header), the account is attached directly to the REPORT root,
      // so its ancestor path is just [ownName]. Ancestor-based classification
      // then correctly refuses to guess a section from the account's own name
      // and returns null -- leaving accountType null, no anchor prefix, and
      // the account stranded in "NEEDS MAPPING" even though its section was
      // sitting on the row all along. Confirmed live: 8 accounts across both
      // assets and liabilities, every one with section already correctly set
      // and parent_path NULL.
      sourceSection: row.section ?? row.account_type ?? null,
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
    // CONFIRMED ROOT CAUSE (fixed here): this used to be `[path[0]]` -- only
    // the OUTERMOST ancestor -- so the P&L reference tree was flattened to
    // exactly ONE level below its section root, silently discarding every
    // intermediate document group. A real document reading
    // "Expenses > Payroll > Salaries" produced a tree of
    // "Expenses > Salaries", losing "Payroll" entirely, and that loss then
    // propagated into hierarchy_path and level_1..15 for every P&L account
    // nested more than one level deep. The Balance Sheet builder above
    // already uses the row's FULL parent_path (ensureTotalPath(root,
    // row.parent_path)); the P&L side must too -- the document's own
    // ancestry is the source of truth for depth, not a fixed one-level
    // assumption.
    const sectionPath = path.length ? path : [row?.section && relationship === "SUBTRACT" ? "Expenses" : "Income"];
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
      // Same as the Balance Sheet builder above -- the row's own
      // document-derived section, carried verbatim as fallback evidence for
      // when ancestor-based classification cannot resolve a section.
      sourceSection: row?.section ?? null,
    });
  }
  return root;
}

module.exports = {
  buildBalanceSheetTreeFromData,
  buildProfitLossTreeFromData,
};
