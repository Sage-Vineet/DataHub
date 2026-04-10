function extractRows(payload) {
  return (
    payload?.Rows?.Row ||
    payload?.data?.Rows?.Row ||
    payload?.data?.data?.Rows?.Row ||
    payload?.data?.data?.data?.Rows?.Row ||
    []
  );
}

function getNumericInfo(columns = []) {
  const numbers = columns
    .map((item) => {
      const raw = item?.value;
      if (raw === undefined || raw === null || raw === "") return NaN;
      return toNumber(raw);
    })
    .filter((value) => !Number.isNaN(value));

  return {
    found: numbers.length > 0,
    value: numbers.length > 0 ? numbers[numbers.length - 1] : 0,
  };
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  return Number(value.replace(/,/g, "").replace(/[^\d.-]/g, "")) || 0;
}

function getLabel(row) {
  return (
    row?.Header?.ColData?.[0]?.value ||
    row?.Summary?.ColData?.[0]?.value ||
    row?.ColData?.[0]?.value ||
    ""
  );
}

function getAmount(row) {
  return getNumericInfo([
    ...(row?.Summary?.ColData || []),
    ...(row?.ColData || []),
  ]).value;
}

function parseSummaryRow(row, path) {
  const children = (row?.Rows?.Row || [])
    .map((child, index) => parseSummaryRow(child, `${path}-${index}`))
    .filter(Boolean);
  const name = getLabel(row) || "Untitled";
  const explicitAmount = getAmount(row);
  const derivedAmount = children.reduce(
    (sum, child) => sum + Number(child.amount || 0),
    0,
  );
  const amount = explicitAmount || derivedAmount;
  const lowerName = name.toLowerCase();

  return {
    id: path,
    name,
    amount,
    type: lowerName.includes("total")
      ? "total"
      : children.length > 0
        ? "header"
        : "detail",
    children: children.length > 0 ? children : undefined,
  };
}

function isTransactionRow(row) {
  const columns = row?.ColData || [];
  if (columns.length < 6) return false;
  const first = String(columns[0]?.value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(first) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(first);
}

function transactionFromRow(row, path) {
  if (!isTransactionRow(row)) return null;
  const columns = row?.ColData || [];

  return {
    id: path,
    date: columns[0]?.value || "",
    type: columns[1]?.value || "",
    num: columns[2]?.value || "",
    name: columns[3]?.value || "",
    memo: columns[4]?.value || "",
    split: columns[5]?.value || "",
    amount: toNumber(columns[6]?.value),
    balance: toNumber(columns[7]?.value),
  };
}

function collectTransactions(rows, path) {
  const transactions = [];

  for (const [index, row] of rows.entries()) {
    const transaction = transactionFromRow(row, `${path}-tx-${index}`);
    if (transaction) {
      transactions.push(transaction);
      continue;
    }

    if (Array.isArray(row?.Rows?.Row) && row.Rows.Row.length > 0) {
      transactions.push(...collectTransactions(row.Rows.Row, `${path}-${index}`));
    }
  }

  return transactions;
}

function parseAccounts(rows, path) {
  const accounts = [];

  for (const [index, row] of rows.entries()) {
    const childRows = row?.Rows?.Row || [];
    const directTransaction = transactionFromRow(row, `${path}-direct-${index}`);

    if (directTransaction) {
      accounts.push({
        id: `${path}-account-${index}`,
        name: directTransaction.name || getLabel(row) || "Transaction",
        total: Number(directTransaction.amount || 0),
        transactions: [directTransaction],
      });
      continue;
    }

    const transactions = collectTransactions(childRows, `${path}-${index}`);
    if (transactions.length > 0) {
      accounts.push({
        id: `${path}-account-${index}`,
        name: getLabel(row) || `Account ${index + 1}`,
        total:
          getAmount(row) ||
          transactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0),
        transactions,
      });
      continue;
    }

    if (childRows.length > 0) {
      accounts.push(...parseAccounts(childRows, `${path}-${index}`));
    }
  }

  return accounts;
}

export function parseSummaryReport(payload) {
  return extractRows(payload)
    .map((row, index) => parseSummaryRow(row, `line-${index}`))
    .filter(Boolean);
}

export function parseDetailReport(payload) {
  const groups = extractRows(payload)
    .map((row, index) => {
      const accounts = parseAccounts(row?.Rows?.Row || [], `group-${index}`);
      return {
        id: `group-${index}`,
        name: getLabel(row) || `Group ${index + 1}`,
        total:
          getAmount(row) ||
          accounts.reduce((sum, account) => sum + Number(account.total || 0), 0),
        accounts,
      };
    })
    .filter((group) => group.accounts.length > 0 || group.name);

  return { groups };
}

function buildCashflowTransaction({
  id,
  label,
  amount,
  groupName,
  parentLabels = [],
  type = "Cash Flow",
  num = "",
  balance = 0,
}) {
  const name = String(label || "").trim();
  const memo = parentLabels.filter(Boolean).join(" > ");

  if (!name && !amount) {
    return null;
  }

  return {
    id,
    date: "",
    type,
    num,
    name,
    memo,
    split: groupName || "",
    amount: Number(amount || 0),
    balance: Number(balance || 0),
  };
}

function buildCashflowLineTransaction(
  row,
  path,
  groupName,
  parentLabels = [],
  runningBalance,
) {
  const columns = row?.ColData || [];
  const label = columns[0]?.value || getLabel(row);
  const amountInfo = getNumericInfo(columns);

  if (!amountInfo.found || !label) {
    return null;
  }

  runningBalance.value += amountInfo.value;

  return buildCashflowTransaction({
    id: path,
    label,
    amount: amountInfo.value,
    groupName,
    parentLabels,
    type: row?.type || "Cash Flow",
    num: columns[0]?.id || row?.group || "",
    balance: runningBalance.value,
  });
}

function buildCashflowSummaryTransaction(
  row,
  path,
  groupName,
  parentLabels = [],
  runningBalance,
) {
  const columns = row?.Summary?.ColData || [];
  const label = columns[0]?.value || getLabel(row);
  const amountInfo = getNumericInfo(columns);

  if (!amountInfo.found || !label) {
    return null;
  }

  runningBalance.value = amountInfo.value;

  return buildCashflowTransaction({
    id: path,
    label,
    amount: amountInfo.value,
    groupName,
    parentLabels,
    type: "Summary",
    num: row?.group || "",
    balance: amountInfo.value,
  });
}

function collectCashflowTransactions(
  rows,
  path,
  groupName,
  parentLabels = [],
  runningBalance = { value: 0 },
) {
  const transactions = [];

  rows.forEach((row, index) => {
    const childRows = row?.Rows?.Row || [];
    const label = getLabel(row);

    if (childRows.length > 0) {
      const nextParentLabels = label
        ? [...parentLabels, label]
        : parentLabels;

      transactions.push(
        ...collectCashflowTransactions(
          childRows,
          `${path}-${index}`,
          groupName,
          nextParentLabels,
          runningBalance,
        ),
      );

      const summaryTransaction = buildCashflowSummaryTransaction(
        row,
        `${path}-${index}-summary`,
        groupName,
        parentLabels,
        runningBalance,
      );

      if (summaryTransaction) {
        transactions.push(summaryTransaction);
      }

      return;
    }

    const lineTransaction = buildCashflowLineTransaction(
      row,
      `${path}-${index}`,
      groupName,
      parentLabels,
      runningBalance,
    );

    if (lineTransaction) {
      transactions.push(lineTransaction);
    }
  });

  return transactions;
}

function parseCashflowAccount(row, path, groupName, parentLabels = []) {
  const label = getLabel(row);
  const childRows = row?.Rows?.Row || [];

  if (childRows.length > 0) {
    const runningBalance = { value: 0 };
    const transactions = collectCashflowTransactions(
      childRows,
      `${path}-rows`,
      groupName,
      label ? [...parentLabels, label] : parentLabels,
      runningBalance,
    );
    const summaryTransaction = buildCashflowSummaryTransaction(
      row,
      `${path}-summary`,
      groupName,
      parentLabels,
      runningBalance,
    );

    if (summaryTransaction) {
      transactions.push(summaryTransaction);
    }

    if (transactions.length === 0) {
      return null;
    }

    const summaryInfo = getNumericInfo(row?.Summary?.ColData || []);

    return {
      id: `${path}-account`,
      name: label || "Summary",
      total: summaryInfo.found
        ? summaryInfo.value
        : transactions[transactions.length - 1]?.balance || 0,
      transactions,
    };
  }

  const runningBalance = { value: 0 };
  const transaction = buildCashflowLineTransaction(
    row,
    `${path}-line`,
    groupName,
    parentLabels,
    runningBalance,
  );

  if (!transaction) {
    const summaryTransaction = buildCashflowSummaryTransaction(
      row,
      `${path}-summary-only`,
      groupName,
      parentLabels,
      runningBalance,
    );

    if (!summaryTransaction) {
      return null;
    }

    return {
      id: `${path}-account`,
      name: "Summary",
      total: Number(summaryTransaction.amount || 0),
      transactions: [summaryTransaction],
    };
  }

  return {
    id: `${path}-account`,
    name: label || "Line Item",
    total: Number(transaction.amount || 0),
    transactions: [transaction],
  };
}

function parseCashflowGroup(row, index) {
  const groupName = row?.Header?.ColData?.[0]?.value || getLabel(row);
  const childRows = row?.Rows?.Row || [];
  const accounts = childRows
    .map((child, childIndex) =>
      parseCashflowAccount(child, `group-${index}-${childIndex}`, groupName),
    )
    .filter(Boolean);

  const groupSummary = buildCashflowSummaryTransaction(
    row,
    `group-${index}-summary`,
    groupName,
    [],
    { value: 0 },
  );

  if (groupSummary) {
    accounts.push({
      id: `group-${index}-summary-account`,
      name: "Summary",
      total: Number(groupSummary.amount || 0),
      transactions: [groupSummary],
    });
  }

  const summaryInfo = getNumericInfo(row?.Summary?.ColData || []);

  return {
    id: `group-${index}`,
    name: groupName || `Group ${index + 1}`,
    total: summaryInfo.found
      ? summaryInfo.value
      : accounts.reduce((sum, account) => sum + Number(account.total || 0), 0),
    accounts,
  };
}

export function parseCashflowDetailReport(payload) {
  const rows = extractRows(payload);
  const groups = rows
    .map((row, index) => {
      if (row?.Header?.ColData?.length || (row?.Rows?.Row || []).length > 0) {
        return parseCashflowGroup(row, index);
      }

      const standaloneAccount = parseCashflowAccount(
        row,
        `group-${index}-standalone`,
        getLabel(row),
      );

      if (!standaloneAccount) {
        return null;
      }

      return {
        id: `group-${index}`,
        name: getLabel(row) || `Group ${index + 1}`,
        total: Number(standaloneAccount.total || 0),
        accounts: [standaloneAccount],
      };
    })
    .filter((group) => group && group.accounts.length > 0);

  return { groups };
}

function transactionFromLedgerRow(row, path) {
  const columns = row?.ColData || [];
  const hasContent = columns.some(
    (column) => String(column?.value ?? "").trim() !== "",
  );

  if (row?.type !== "Data" || !hasContent) {
    return null;
  }

  return {
    id: path,
    date: columns[0]?.value || "",
    type: columns[1]?.value || "",
    num: columns[2]?.value || "",
    name: columns[3]?.value || "",
    memo: columns[4]?.value || "",
    split: columns[5]?.value || "",
    amount: toNumber(columns[6]?.value),
    balance: toNumber(columns[7]?.value),
  };
}

function parseLedgerAccounts(rows, path) {
  const accounts = [];

  rows.forEach((row, index) => {
    const childRows = row?.Rows?.Row || [];
    const directTransactions = childRows
      .map((child, childIndex) =>
        transactionFromLedgerRow(child, `${path}-${index}-tx-${childIndex}`),
      )
      .filter(Boolean);
    const nestedSections = childRows.filter(
      (child) => Array.isArray(child?.Rows?.Row) && child.Rows.Row.length > 0,
    );

    if (directTransactions.length > 0) {
      const summaryInfo = getNumericInfo(row?.Summary?.ColData || []);
      accounts.push({
        id: `${path}-account-${index}`,
        name: getLabel(row) || `Account ${index + 1}`,
        total: summaryInfo.found
          ? summaryInfo.value
          : directTransactions.reduce(
              (sum, transaction) => sum + Number(transaction.amount || 0),
              0,
            ),
        transactions: directTransactions,
      });
    }

    if (nestedSections.length > 0) {
      accounts.push(...parseLedgerAccounts(nestedSections, `${path}-${index}`));
    }
  });

  return accounts;
}

export function parseGeneralLedgerDetailReport(payload) {
  const groups = extractRows(payload)
    .map((row, index) => {
      const accounts = parseLedgerAccounts([row], `group-${index}`);
      const summaryInfo = getNumericInfo(row?.Summary?.ColData || []);

      return {
        id: `group-${index}`,
        name: getLabel(row) || `Group ${index + 1}`,
        total: summaryInfo.found
          ? summaryInfo.value
          : accounts.reduce(
              (sum, account) => sum + Number(account.total || 0),
              0,
            ),
        accounts,
      };
    })
    .filter((group) => group.accounts.length > 0);

  return { groups };
}
