const DETAIL_UI_RECORD_LIMIT = 50;

function cloneTransaction(transaction) {
  return {
    id: transaction.id,
    date: transaction.date || "",
    type: transaction.type || "",
    num: transaction.num || "",
    name: transaction.name || "",
    memo: transaction.memo || "",
    split: transaction.split || "",
    amount: Number(transaction.amount || 0),
    balance: Number(transaction.balance || 0),
  };
}

export function buildDetailPreview(
  data,
  maxTransactions = DETAIL_UI_RECORD_LIMIT,
) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  let totalRecords = 0;
  const previewGroups = [];

  for (const group of groups) {
    const nextGroup = {
      id: group.id,
      name: group.name,
      total: Number(group.total || 0),
      accounts: [],
    };

    for (const account of group.accounts || []) {
      const accountTransactions = Array.isArray(account.transactions)
        ? account.transactions
        : [];
      totalRecords += accountTransactions.length;

      if (maxTransactions <= 0) continue;
      if (accountTransactions.length === 0) continue;

      const allowedTransactions = accountTransactions
        .slice(0, maxTransactions)
        .map(cloneTransaction);

      maxTransactions -= allowedTransactions.length;

      if (allowedTransactions.length > 0) {
        nextGroup.accounts.push({
          id: account.id,
          name: account.name,
          total: Number(account.total || 0),
          transactions: allowedTransactions,
        });
      }

      if (maxTransactions <= 0) {
        break;
      }
    }

    if (nextGroup.accounts.length > 0) {
      previewGroups.push(nextGroup);
    }

    if (maxTransactions <= 0) {
      break;
    }
  }

  const visibleRecords = previewGroups.reduce(
    (sum, group) =>
      sum +
      group.accounts.reduce(
        (accountSum, account) => accountSum + account.transactions.length,
        0,
      ),
    0,
  );

  return {
    previewData: { groups: previewGroups },
    totalRecords,
    visibleRecords,
    isTruncated: visibleRecords < totalRecords,
  };
}
