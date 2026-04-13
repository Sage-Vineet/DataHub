import { fetchProfitAndLoss } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";
import { parseDetailReport, parseSummaryReport } from "../lib/report-parsers";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"
).replace(/\/$/, "");

function resolveClientIdFromLocation() {
  if (typeof window === "undefined") return null;

  const hash = window.location.hash || "";
  const pathname = window.location.pathname || "";
  const hashMatch = hash.match(/\/client\/([^/?#]+)/);
  const pathMatch = pathname.match(/\/client\/([^/?#]+)/);
  const match = hashMatch || pathMatch;

  return match ? decodeURIComponent(match[1]) : null;
}

function buildQuery(params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return search.toString() ? `?${search.toString()}` : "";
}

async function request(path) {
  const clientId = resolveClientIdFromLocation();

  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(clientId ? { "X-Client-Id": clientId } : {}),
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed: ${response.status}`);
  }

  return payload;
}

export async function getProfitAndLoss(startDate, endDate, accountingMethod) {
  const payload = await fetchProfitAndLoss({
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(accountingMethod
      ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
      : {}),
  });

  return parseSummaryReport(payload);
}

export async function getProfitAndLossDetail(startDate, endDate, accountingMethod) {
  const payload = await request(
    `/profit-and-loss-detail${buildQuery({
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    })}`,
  );

  return {
    ...parseDetailReport(payload),
    rawPayload: payload,
  };
}
