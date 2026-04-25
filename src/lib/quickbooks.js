import { getStoredToken } from "./api";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "https://datahub-sl3y.onrender.com"
).replace(/\/$/, "");

async function request(path, options = {}) {
  // Extract clientId from URL hash
  // Matches /broker/client/:id, /client/:id/dashboard, or /client/:id/...
  const hash = window.location.hash || "";
  const brokerMatch = hash.match(/\/broker\/client\/([^/?#]+)/);
  const workspaceMatch = hash.match(/\/broker\/workspace\/([^/?#]+)/);
  const clientMatch = hash.match(/\/client\/([^/?#]+)/);

  let clientId = brokerMatch ? brokerMatch[1] : (workspaceMatch ? workspaceMatch[1] : (clientMatch ? clientMatch[1] : null));

  // Safety: ensure it looks like a database ID (UUID) and not a static route like 'connections'
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (clientId && !uuidRegex.test(clientId)) {
    clientId = null;
  }

  const token = getStoredToken();

  const response = await fetch(`${API_BASE_URL}${path}`, {
    cache: "no-store",
    credentials: "include",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(clientId ? { "X-Client-Id": clientId } : {}),
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
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

export function connectQuickbooks(redirectHash, explicitClientId = null) {
  const hash = window.location.hash || "";
  // 1. Try explicit ID (passed from component)
  // 2. Try broker path
  // 3. Try client path
  const brokerMatch = hash.match(/\/broker\/client\/([^/?#]+)/);
  const workspaceMatch = hash.match(/\/broker\/workspace\/([^/?#]+)/);
  const clientMatch = hash.match(/\/client\/([^/?#]+)/);

  let clientId = explicitClientId || (brokerMatch ? brokerMatch[1] : (workspaceMatch ? workspaceMatch[1] : (clientMatch ? clientMatch[1] : null)));

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (clientId && !uuidRegex.test(clientId)) {
    clientId = null;
  }

  const isClient = hash.includes("/client/");
  const role = isClient ? "client" : "broker";

  const state = encodeURIComponent(
    JSON.stringify({
      redirect: redirectHash || (isClient ? "/client/connections" : "/broker/companies"),
      companyId: clientId,
      clientId: clientId, // backward compat
      role: role
    })
  );

  const token = getStoredToken();
  const authQuery = token ? `&token=${encodeURIComponent(token)}` : "";
  window.location.href = `${API_BASE_URL}/api/auth/quickbooks?state=${state}&clientId=${clientId || ""}${authQuery}`;
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
