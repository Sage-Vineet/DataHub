import { fetchQuickbooksInvoices } from "../lib/quickbooks";

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

export function fetchInvoices() {
  return fetchQuickbooksInvoices();
}

export function getInvoiceByDocNumber(docNumber) {
  return request(`/invoices/doc/${encodeURIComponent(docNumber)}`);
}

export function updateInvoice(id, body) {
  return request(`/api/invoices/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
