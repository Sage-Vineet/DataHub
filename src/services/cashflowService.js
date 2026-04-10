import { fetchCashflow } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";
import {
  parseCashflowDetailReport,
  parseSummaryReport,
} from "../lib/report-parsers";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"
).replace(/\/$/, "");

function buildQuery(params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return search.toString() ? `?${search.toString()}` : "";
}

async function request(path) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Request failed: ${response.status}`);
  }

  return payload;
}

export async function getCashflow(startDate, endDate, accountingMethod) {
  const payload = await fetchCashflow({
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(accountingMethod
      ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
      : {}),
  });

  return parseSummaryReport(payload);
}

export async function getCashflowDetail(startDate, endDate, accountingMethod) {
  const payload = await request(
    `/qb-cashflow-engine${buildQuery({
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
      : {}),
    })}`,
  );

  const detailSource = payload?.cashflow || payload;

  return {
    ...parseCashflowDetailReport(detailSource),
    rawPayload: detailSource,
  };
}
