const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"
).replace(/\/$/, "");

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
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
  const state = encodeURIComponent(redirectHash || "/broker/companies");
  window.location.href = `${API_BASE_URL}/api/auth/quickbooks?state=${state}`;
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

export function fetchReconciliationData() {
  return request("/reconciliation-data");
}

export function fetchReconciliationVariance() {
  return request("/api/reconciliation-variance");
}

export function uploadBankStatement(file) {
  const form = new FormData();
  form.append("file", file);
  return request("/upload-bank-statement", {
    method: "POST",
    body: form,
  });
}

export function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(amount || 0));
}
