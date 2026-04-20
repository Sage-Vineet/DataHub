const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "https://datahub-sl3y.onrender.com"
).replace(/\/$/, "");

async function request(path, options = {}) {
  // Extract clientId from URL hash: #/broker/client/:clientId/...
  const hash = window.location.hash || "";
  const match = hash.match(/\/client\/([^/]+)/);
  const clientId = match ? match[1] : null;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(clientId ? { "X-Client-Id": clientId } : {}),
      ...(options.headers || {}),
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);

  if (!response.ok) {
    const errorMessage =
      payload?.message ||
      payload?.error ||
      `Request failed: ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload;
}

export function connectQuickbooks(redirectHash) {
  const hash = window.location.hash || "";
  const match = hash.match(/\/client\/([^/]+)/);
  const clientId = match ? match[1] : null;

  const state = encodeURIComponent(
    JSON.stringify({
      redirect: redirectHash || "/broker/companies",
      clientId: clientId,
    }),
  );
  window.location.href = `${API_BASE_URL}/api/auth/quickbooks?state=${state}&clientId=${clientId || ""}`;
}

export function getConnectionStatus() {
  return request("/api/auth/status");
}

export function disconnectQuickbooks() {
  return request("/api/auth/disconnect");
}

export function refreshQuickbooksToken() {
  return request("/refresh-token");
}

export function fetchQuickbooksCustomers() {
  return request("/customers");
}

export function createQuickbooksCustomer(body) {
  return request("/customers", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchQuickbooksInvoices() {
  return request("/invoices");
}

export function fetchBalanceSheet(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`/balance-sheet${query ? `?${query}` : ""}`);
}

export function fetchProfitAndLoss(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`/profit-and-loss-statement${query ? `?${query}` : ""}`);
}

export function fetchCashflow(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`/qb-cashflow${query ? `?${query}` : ""}`);
}

export function syncGeneralLedger(params = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`/qb-general-ledger${query ? `?${query}` : ""}`);
}

export function fetchBankVsBooks() {
  return request("/bank-vs-books");
}

export function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(amount || 0));
}
