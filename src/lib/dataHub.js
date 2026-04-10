const HEALTH_SCORES = [94, 88, 81, 76, 91, 84];
const PAYMENT_WINDOWS = ['On track', '2 days late', 'Review needed', '7 days late', 'On track', '5 days late'];
const RELATIONSHIP_TIERS = ['Strategic', 'Growth', 'Standard', 'Watchlist', 'Strategic', 'Growth'];
const CONNECTION_STATES = ['Connected', 'Connected', 'Pending setup', 'Attention needed'];

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

export function buildClientLedger(companies = []) {
  return companies.map((company, index) => {
    const score = HEALTH_SCORES[index % HEALTH_SCORES.length];
    const requestCount = Number(company.requestCount || company.request_count || 0);
    const pendingCount = Number(company.pendingCount || company.pending_request_count || 0);
    const completedCount = Number(company.completedCount || company.completed_request_count || 0);
    const baseBalance = 12000 + (index + 1) * 4250 + pendingCount * 900;
    const lifetimeValue = 45000 + (index + 1) * 15000 + completedCount * 1200;

    return {
      ...company,
      healthScore: score,
      relationshipTier: RELATIONSHIP_TIERS[index % RELATIONSHIP_TIERS.length],
      paymentWindow: PAYMENT_WINDOWS[index % PAYMENT_WINDOWS.length],
      openBalance: baseBalance,
      lifetimeValue,
      lastFinanceSync: `2026-04-0${(index % 5) + 3}`,
      workspaceLoad: requestCount || pendingCount + completedCount,
      accountOwner: company.contact || company.contact_name || 'Relationship Desk',
      financeStatus: score >= 90 ? 'healthy' : score >= 80 ? 'stable' : 'at-risk',
    };
  });
}

export function buildInvoiceLedger(clients = []) {
  return clients.flatMap((client, index) => {
    const baseDate = new Date(2026, 2 + (index % 2), 3 + index);
    const dueDate = new Date(baseDate);
    dueDate.setDate(baseDate.getDate() + 14);

    const invoices = [
      {
        id: `INV-${1000 + index * 2}`,
        clientId: client.id,
        clientName: client.name,
        status: index % 3 === 0 ? 'Paid' : 'Open',
        amount: 9000 + index * 1350,
        balance: index % 3 === 0 ? 0 : 3200 + index * 425,
        category: 'Advisory Retainer',
        date: baseDate.toISOString().slice(0, 10),
        dueDate: dueDate.toISOString().slice(0, 10),
      },
      {
        id: `INV-${1001 + index * 2}`,
        clientId: client.id,
        clientName: client.name,
        status: index % 4 === 0 ? 'Overdue' : 'Draft',
        amount: 4800 + index * 980,
        balance: index % 4 === 0 ? 4800 + index * 980 : 0,
        category: 'Document Review Sprint',
        date: new Date(2026, 1 + (index % 3), 12 + index).toISOString().slice(0, 10),
        dueDate: new Date(2026, 2 + (index % 3), 2 + index).toISOString().slice(0, 10),
      },
    ];

    return invoices.map((invoice) => ({
      ...invoice,
      formattedAmount: formatCurrency(invoice.amount),
      formattedBalance: formatCurrency(invoice.balance),
    }));
  });
}

export function summarizeInvoices(invoices = []) {
  return invoices.reduce(
    (summary, invoice) => {
      summary.totalVolume += invoice.amount;
      summary.outstanding += invoice.balance;

      if (invoice.status === 'Paid') summary.paidCount += 1;
      if (invoice.status === 'Open') summary.openCount += 1;
      if (invoice.status === 'Overdue') summary.overdueCount += 1;

      return summary;
    },
    { totalVolume: 0, outstanding: 0, paidCount: 0, openCount: 0, overdueCount: 0 }
  );
}

export function buildReportLibrary(clients = [], invoices = []) {
  const invoiceSummary = summarizeInvoices(invoices);

  return [
    {
      id: 'portfolio-health',
      title: 'Portfolio Health',
      description: 'Client health, active workstreams, and open balances by relationship tier.',
      metric: `${clients.filter((client) => client.financeStatus !== 'at-risk').length}/${clients.length || 0}`,
      metricLabel: 'Healthy accounts',
      accent: '#8BC53D',
    },
    {
      id: 'receivables',
      title: 'Receivables Snapshot',
      description: 'Open, overdue, and cleared invoices in the merged workspace.',
      metric: formatCurrency(invoiceSummary.outstanding),
      metricLabel: 'Outstanding balance',
      accent: '#00648F',
    },
    {
      id: 'broker-activity',
      title: 'Broker Activity',
      description: 'How much client follow-up is needed based on reminders and open invoice states.',
      metric: `${invoiceSummary.overdueCount + invoiceSummary.openCount}`,
      metricLabel: 'Active finance follow-ups',
      accent: '#F68C1F',
    },
  ];
}

export function buildConnectionCards() {
  return [
    {
      id: 'workspace-core',
      name: 'Leo Broker Workspace',
      status: CONNECTION_STATES[0],
      detail: 'Primary broker workflow is live and unchanged.',
      lastChecked: 'Just now',
    },
    {
      id: 'datahub-finance',
      name: 'Data Hub Finance Layer',
      status: CONNECTION_STATES[1],
      detail: 'Finance pages are merged into the broker navigation.',
      lastChecked: 'Today',
    },
    {
      id: 'quickbooks',
      name: 'QuickBooks Sync',
      status: CONNECTION_STATES[2],
      detail: 'Backend credentials can be wired later without changing the UI merge.',
      lastChecked: 'Setup required',
    },
    {
      id: 'alerts',
      name: 'Reminder Automations',
      status: CONNECTION_STATES[3],
      detail: 'Review overdue reminders and manual follow-ups from one place.',
      lastChecked: 'Needs review',
    },
  ];
}

export function formatUsd(value) {
  return formatCurrency(value);
}
