import { fetchBalanceSheet } from "../lib/quickbooks";
import { normalizeAccountingMethod } from "../lib/report-filters";
import {
  parseBalanceSheetDetailFromAllReports,
  parseDetailReport,
  parseSummaryReport,
} from "../lib/report-parsers";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"
).replace(/\/$/, "");

function buildQuery(params = {}) {
  const search = new URLSearchParams(
    Object.entries(params).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
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
    throw new Error(
      payload?.message ||
        payload?.error ||
        `Request failed: ${response.status}`,
    );
  }

  return payload;
}

export async function getBalanceSheet(startDate, endDate, accountingMethod) {
  const payload = await fetchBalanceSheet({
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(accountingMethod
      ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
      : {}),
  });

  return parseSummaryReport(payload);
}

export async function getBalanceSheetDetail(
  startDate,
  endDate,
  accountingMethod,
) {
  const payload = await request(
    `/all-reports${buildQuery({
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      ...(accountingMethod
        ? { accounting_method: normalizeAccountingMethod(accountingMethod) }
        : {}),
    })}`,
  );

  const balanceSheetReport =
    payload?.balanceSheet ??
    payload?.BalanceSheet ??
    payload?.data?.balanceSheet ??
    payload?.data?.BalanceSheet;
  const generalLedgerReport =
    payload?.generalLedger ??
    payload?.GeneralLedger ??
    payload?.data?.generalLedger ??
    payload?.data?.GeneralLedger;

  if (
    balanceSheetReport &&
    generalLedgerReport &&
    !generalLedgerReport?.error
  ) {
    const parsed = parseBalanceSheetDetailFromAllReports(payload, endDate);
    if (parsed?.groups?.length) {
      return {
        ...parsed,
        rawPayload: payload,
      };
    }
  }

  // Balance sheet "detail" view is rendered from the General Ledger report,
  // since the BalanceSheet report itself is summary-only in QuickBooks.
  // Some deployments return `GeneralLedger`/`BalanceSheet` (PascalCase) keys.
  const generalLedger = payload?.generalLedger ?? payload?.GeneralLedger;
  const balanceSheet = payload?.balanceSheet ?? payload?.BalanceSheet;

  const detailSource =
    (generalLedger && !generalLedger?.error ? generalLedger : null) ||
    (balanceSheet && !balanceSheet?.error ? balanceSheet : null) ||
    payload;

  return {
    ...parseDetailReport(detailSource),
    rawPayload: detailSource,
  };
}
