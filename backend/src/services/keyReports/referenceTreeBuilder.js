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

// ─── ONE canonical document-ancestry resolver ────────────────────────────────
//
// The SINGLE source of truth for "what is this row's ancestor chain in the
// uploaded document", shared by the Balance Sheet and Profit & Loss builders
// below. Both statements are laid out the same way by the same accounting
// systems, so they must not have two independent ancestry algorithms that can
// drift (the P&L builder previously had none at all -- see its own note).
//
// Two signals, in priority order:
//   1. row.parent_path -- the extractor's own ancestry, read from the
//      document's indentation. PRIMARY: an indented document is unaffected.
//   2. Header/total BRACKETING -- a header row OPENS a scope and a matching
//      "Total for <same name>" row CLOSES it, with the children in between.
//      This is how QuickBooks (and similar) convey nesting when the export
//      carries NO indentation at all: confirmed on a real client export where
//      every single row had parent_path empty, no leading whitespace, no cell
//      indent attribute, and every label sat in column A.
//
// Purely structural and document-driven: a row opens a scope IFF the document
// itself also contains a total row closing that same name. No keywords, no
// account-name rules, no assumed depth, no per-company special cases.
//
// @param {Array} rows document rows in document order
// @returns {Array} one entry per row (null for nameless rows):
//   { ancestry: string[], hasOwnParentPath, isTotalRow, sectionName, closesOpenScope, isContainer }
function resolveDocumentAncestry(rows) {
  // A name is a container iff the document closes it with its own total row.
  const closesAScope = new Set();
  for (const r of rows || []) {
    if (isTotal(r)) closesAScope.add(normName(stripTotalPrefix(rowName(r))));
  }

  const out = [];
  // Bracketing is only meaningful within ONE report, so the stack resets
  // whenever the row sequence moves to a different source document / period.
  let scopeStack = [];
  let scopeKey = null;
  const top = () => (scopeStack.length ? normName(scopeStack[scopeStack.length - 1]) : null);

  for (const row of rows || []) {
    const name = rowName(row);
    if (!name) { out.push(null); continue; }

    // CONFIRMED ROOT CAUSE (fixed here): this key used to include fiscal_year.
    // Both extractors emit one row PER PERIOD COLUMN -- and that includes the
    // header/group and total rows, not just the accounts. So on a multi-year
    // document the key changed on essentially every row and reset the bracketing
    // stack mid-document, destroying the ancestry of everything after the first
    // row:
    //   Income(2023) reset+push, Income(2024) reset+push, Income(2025) reset+push,
    //   Sales(2023)  reset -> ancestry EMPTY, "Income" gone.
    // A single-period document has one constant fiscal_year, so it was unaffected
    // -- which is exactly why this stayed hidden until a genuinely multi-year P&L
    // was used.
    //
    // Bracketing is a property of ONE DOCUMENT read top to bottom, so the scope
    // is the source document alone. Callers already keep each document's rows
    // contiguous (see keyReportSyncService's balanceSheetRowsForTree), and the
    // "only pop when the target is actually open" guard below keeps a repeated
    // total from draining the stack, so a document that repeats its structure per
    // period stays correct.
    const rowScopeKey = `${row.source_file_id ?? ""}`;
    if (rowScopeKey !== scopeKey) { scopeKey = rowScopeKey; scopeStack = []; }

    const hasOwnParentPath = Array.isArray(row.parent_path) && row.parent_path.length > 0;
    const ancestry = hasOwnParentPath ? row.parent_path : [...scopeStack];
    const isTotalRow = isTotal(row);
    const sectionName = isTotalRow ? stripTotalPrefix(name) : null;
    // Opens a scope iff a matching total closes it later AND it is not already
    // the open scope -- guards a header and a real posting account sharing one
    // name (e.g. header "Accounts Receivable" then account "Accounts Receivable"),
    // and the repeated-row case described below.
    const opensScope = !isTotalRow && closesAScope.has(normName(name)) && top() !== normName(name);
    const closesOpenScope = isTotalRow && !hasOwnParentPath && top() === normName(sectionName);

    out.push({
      ancestry,
      hasOwnParentPath,
      isTotalRow,
      sectionName,
      closesOpenScope,
      // A row is a container iff the document closes it with its own total.
      // A posting account CAN be one: accounting systems emit a parent account
      // that carries its own balance as a normal row, followed later by its own
      // "Total for <name>" (confirmed on a real export: a parent account with
      // amounts whose total equals itself plus its children).
      isContainer: closesAScope.has(normName(name)) && !isTotalRow,
    });

    // Mutate the stack only AFTER this row's own ancestry has been recorded.
    if (isTotalRow) {
      if (!hasOwnParentPath) {
        const target = normName(sectionName);
        // CONFIRMED ROOT CAUSE (guarded here): a P&L export emits one row per
        // PERIOD COLUMN, so the same "Total for X" row legitimately appears
        // N times in a row. Popping unconditionally drains the whole stack on
        // the 2nd occurrence (the target is no longer open), which destroys the
        // ancestry of every row after it. Only pop when the target is genuinely
        // still open.
        if (scopeStack.some((s) => normName(s) === target)) {
          while (scopeStack.length) { if (normName(scopeStack.pop()) === target) break; }
        }
      }
    } else if (!hasOwnParentPath && opensScope) {
      scopeStack.push(name);
    }
  }
  return out;
}

// A HEADING row that the document never closes with its own total row cannot be
// a real container in the bracketing regime -- and since nothing closes it, it
// opens no scope, so no row ever inherits it either: the node it would create is
// necessarily childless. What actually lands here is document chrome, the
// "Cash Basis <timestamp>" / "Accrual Basis <timestamp>" footer these exports
// end with, which the extractor classifies as a heading and which otherwise
// became a first-class tree node (confirmed: it materialised as a
// "Total for Cash Basis Monday, June 29, 2026 02:44 PM GMTZ" container hanging
// off the Equity section).
//
// Structural test only -- no text matching, no keywords, so it cannot misfire on
// a real account or section name. Deliberately scoped to !hasOwnParentPath so a
// properly-indented document is completely unaffected. Amounts are NOT consulted:
// the extractor emits amount=0 (not null) for a value-less row, so an
// amount-based test would never fire here.
function isDocumentChrome(row, info) {
  if (!info || info.isTotalRow || info.isContainer) return false;
  if (info.hasOwnParentPath) return false;
  return Boolean(isHeading(row));
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

  // Ancestry comes from the ONE shared resolver above (parent_path when the
  // extractor captured indentation, otherwise header/"Total for X" bracketing).
  const ancestryInfo = resolveDocumentAncestry(rows);

  rows = rows || [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const info = ancestryInfo[i];
    if (!info) continue;
    const name = rowName(row);
    const amount = rowAmount(row);
    const { ancestry, hasOwnParentPath, isTotalRow, sectionName, closesOpenScope } = info;

    if (isDocumentChrome(row, info)) continue;

    if (isHeading(row) && !isTotalRow) {
      ensureTotalPath(root, [...ancestry, name]);
      continue;
    }
    if (isTotalRow) {
      // A total row IS its section's container node. When it closes the
      // currently-open scope, `ancestry` already ends with that scope, so
      // appending the name again would nest a redundant duplicate total under
      // the node it is supposed to be.
      const totalPath = hasOwnParentPath
        ? [...row.parent_path, sectionName]
        : (closesOpenScope ? [...ancestry] : [...ancestry, sectionName]);
      const totalNode = ensureTotalPath(root, totalPath);
      totalNode.name = totalName(sectionName);
      totalNode.value = amount;
      continue;
    }
    // One tree node per distinct account, first placement wins (see
    // placedAccounts above).
    // CONFIRMED ROOT CAUSE (fixed here): identity was the normalized account
    // NAME ALONE, so the SECOND document row sharing a name was skipped and
    // never became a tree node at all. One real chart legitimately lists
    // "Business Process Outsourcing" twice -- once under Income and once under
    // Cost of goods sold -- and they are two different accounts. With only one
    // node in the tree, buildTreeHierarchyLookup had a single candidate to
    // offer, so both COA leaves resolved to the SAME ancestry and produced the
    // identical hierarchy path, which failed persistApprovedCoaTree's
    // duplicate-leaf-path check and blocked every Save with HTTP 422.
    //
    // Identity is now the name PLUS the document ancestry it sits under. A
    // genuine repeat (same name, same position -- e.g. the same account across
    // fiscal years) still collapses to one node exactly as before; only rows
    // the document itself places somewhere different become distinct nodes.
    const accountKey = `${normName(name)}::${(ancestry || []).map(normName).join(">")}`;
    if (placedAccounts.has(accountKey)) continue;
    placedAccounts.add(accountKey);
    const parent = ensureTotalPath(root, ancestry);
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

  // ── Roll-up LABELS come from the document ────────────────────────────────
  // The income statement's roll-up NESTING (bottom line contains operating
  // result, which contains gross result) is accounting structure, not something
  // any document states -- those rows are siblings in the file. But their LABELS
  // are the document's own words, so they are read from its subtotal rows rather
  // than invented here: a file that says "Net Operating Income" keeps that
  // wording, one that says "Operating Income" keeps its own, and a file that
  // names none of them falls back to the role name so the skeleton the report
  // layer and findFirstProfitAndLossAccount walk always exists.
  //
  // Ordering rule is structural, not name-based: an income statement prints its
  // subtotals innermost-first and the bottom line LAST, so document order maps
  // to depth. Reversed, the last subtotal is the outermost roll-up.
  const docSubtotals = [];
  for (const r of rows || []) {
    if (String(r?.node_type || "").toLowerCase() !== "subtotal") continue;
    const nm = rowName(r);
    if (!nm) continue;
    if (!docSubtotals.some((x) => normName(x) === normName(nm))) docSubtotals.push(nm);
  }
  const outermostFirst = [...docSubtotals].reverse();
  const calcNode = (name) => ({ name, nodeType: "CALCULATED_TOTAL", values: {}, relationship: "ADD", children: [] });
  const n = outermostFirst.length;
  // Three ROLES the section attachment logic below needs: the bottom line, the
  // operating result (where operating expenses attach) and the gross result
  // (where revenue/COGS attach). Their LABELS are the document's outermost,
  // second-innermost and innermost subtotals respectively.
  const netIncome = calcNode(n > 0 ? outermostFirst[0] : "Net Income");
  const grossProfit = calcNode(n > 2 ? outermostFirst[n - 1] : "Gross Profit");
  const netOperatingIncome = calcNode(n > 1 ? outermostFirst[n - 2] : "Net Operating Income");
  const netOtherIncome = calcNode("Net Other Income");
  root.children.push(netIncome);
  // DEPTH FOLLOWS THE DOCUMENT: any subtotals BETWEEN the bottom line and the
  // operating result become their own nested levels, so a statement that prints a
  // pre-tax roll-up gets it as its own level and one that does not simply has a
  // shallower chain. Nothing here assumes how many levels a company reports.
  let cursor = netIncome;
  for (const mid of outermostFirst.slice(1, Math.max(1, n - 2))) {
    const midNode = calcNode(mid);
    cursor.children.push(midNode);
    cursor = midNode;
  }
  cursor.children.push(netOperatingIncome, netOtherIncome);
  netOperatingIncome.children.push(grossProfit);

  const sectionRoot = (row) => {
    const section = String(row?.section || "").toLowerCase();
    if (section === "other_income" || section === "other_expense") return netOtherIncome;
    return grossProfit;
  };

  // CONFIRMED ROOT CAUSE (fixed here): this builder had NO ancestry
  // reconstruction of any kind. It read ancestry ONLY from row.parent_path and,
  // when that was empty, substituted a single invented level -- literally
  // `["Expenses"]` or `["Income"]`. The Balance Sheet builder had already been
  // given header/"Total for X" bracketing for exactly this case; the P&L side
  // never was. On any export that conveys nesting by bracketing rather than
  // indentation (parent_path empty on every row), EVERY intermediate P&L group
  // was therefore destroyed. Confirmed on a real client P&L: all 107 rows had
  // an empty parent_path, and the resulting tree hung 48 accounts flat
  // underneath one "Total for Expenses" node --
  //   Expenses > Advertising and Marketing > Listing fees   (document)
  //   Expenses > Listing fees                               (tree, group lost)
  //   Expenses > Payroll expenses > Payroll Taxes           (document)
  //   Expenses > Payroll Taxes                              (tree, group lost)
  // and every group's own "Total for ..." node was left childless beside them.
  // Other Income / Other Expenses were worse: the invented fallback put
  // "Interest earned" under a fabricated "Income" node and
  // "Vehicle gas & fuel" under a fabricated "Expenses" node, discarding the
  // real "Vehicle expenses" group entirely.
  //
  // Both builders now derive ancestry from the SAME resolver, so there is one
  // document-driven algorithm rather than two that can disagree.
  const ancestryInfo = resolveDocumentAncestry(rows);
  // One tree node per distinct account -- the P&L extractor emits one row per
  // PERIOD COLUMN, so without this every account appeared once per period
  // (confirmed: "Session Income" twice, "Payroll Taxes" twice, ...), leaving its
  // hierarchy ambiguous. Mirrors the Balance Sheet builder's own placedAccounts.
  const placedAccounts = new Set();

  rows = rows || [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const info = ancestryInfo[i];
    if (!info) continue;
    const name = rowName(row);
    const { ancestry, isTotalRow, sectionName } = info;

    if (isDocumentChrome(row, info)) continue;
    // Section headers are placed by their children's ancestry (and by their own
    // total row); they contribute no node of their own here.
    if (isHeading(row) && !isTotalRow) continue;

    const section = String(row?.section || "").toLowerCase();
    const relationship = section.includes("expense") || section === "cost_of_sales" ? "SUBTRACT" : "ADD";
    // Which computed-subtotal branch this row's section belongs under. Retained
    // verbatim: the P&L skeleton (Net Income > Net Operating Income > Gross
    // Profit / Net Other Income) is what findFirstProfitAndLossAccount walks for
    // the GL Retained-Earnings boundary, and what the report layer expects.
    const parentRoot = relationship === "SUBTRACT" && section !== "other_expense"
      ? netOperatingIncome
      : sectionRoot(row);

    if (isTotalRow) {
      // Anchor the total at its real document ancestry, so a nested group's
      // total lands inside its parent group rather than flat under the section.
      const totalPath = info.closesOpenScope
        ? normalizedPath(ancestry)
        : [...normalizedPath(ancestry), sectionName];
      const existingNode = findTotalNode(parentRoot, sectionName);
      const totalNode = existingNode || ensureTotalPath(parentRoot, totalPath.length ? totalPath : [sectionName]);
      totalNode.name = totalName(sectionName);
      totalNode.nodeType = "TOTAL";
      totalNode.values = valuesForRow(row, periodKeys);
      totalNode.relationship = relationship;
      continue;
    }

    // A computed statement line (Gross Profit / Net Operating Income / Net Other
    // Income / Net Income) is not an account and must never become a COA leaf or
    // a hierarchy level -- the skeleton above already represents these.
    if (String(row?.node_type || "").toLowerCase() === "subtotal") continue;

    // CONFIRMED ROOT CAUSE (fixed here): identity was the normalized account
    // NAME ALONE, so the SECOND document row sharing a name was skipped and
    // never became a tree node at all. One real chart legitimately lists
    // "Business Process Outsourcing" twice -- once under Income and once under
    // Cost of goods sold -- and they are two different accounts. With only one
    // node in the tree, buildTreeHierarchyLookup had a single candidate to
    // offer, so both COA leaves resolved to the SAME ancestry and produced the
    // identical hierarchy path, which failed persistApprovedCoaTree's
    // duplicate-leaf-path check and blocked every Save with HTTP 422.
    //
    // Identity is now the name PLUS the document ancestry it sits under. A
    // genuine repeat (same name, same position -- e.g. the same account across
    // fiscal years) still collapses to one node exactly as before; only rows
    // the document itself places somewhere different become distinct nodes.
    const accountKey = `${normName(name)}::${normalizedPath(ancestry).map(normName).join(">")}`;
    if (placedAccounts.has(accountKey)) continue;
    placedAccounts.add(accountKey);

    // The document's own ancestry, verbatim -- no invented fallback level. An
    // account the document genuinely places at the section root correctly gets
    // an empty path and attaches directly to its section branch.
    const parent = ensureTotalPath(parentRoot, normalizedPath(ancestry));
    parent.relationship = relationship === "SUBTRACT" ? "SUBTRACT" : "ADD";
    parent.children.push({
      name,
      nodeType: "ACCOUNT",
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
