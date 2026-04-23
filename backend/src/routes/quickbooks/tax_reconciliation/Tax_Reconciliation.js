const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");

const router = express.Router();
const QB_THROTTLE_STATUS = 429;
const QB_MAX_RETRIES = 3;
const QB_REQUEST_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const raw = String(value).trim();
  if (!raw) return 0;

  const isNegative = raw.startsWith("(") && raw.endsWith(")");
  const normalized = raw.replace(/[,$()]/g, "");
  const parsed = Number.parseFloat(normalized);

  if (!Number.isFinite(parsed)) return 0;
  return isNegative ? -parsed : parsed;
}

function rowName(row) {
  return (
    row?.Header?.ColData?.[0]?.value ||
    row?.ColData?.[0]?.value ||
    row?.group ||
    ""
  );
}

function rowAmount(row) {
  return toNumber(
    row?.Summary?.ColData?.[1]?.value ??
      row?.ColData?.[1]?.value ??
      row?.Summary?.ColData?.at?.(-1)?.value ??
      row?.ColData?.at?.(-1)?.value ??
      0,
  );
}

function accumulatePLRows(rows, metrics) {
  rows.forEach((row) => {
    if (row?.Rows?.Row?.length) {
      accumulatePLRows(row.Rows.Row, metrics);
    }

    const name = rowName(row).toLowerCase();
    const amount = rowAmount(row);

    if (!name) return;

    if (name.includes("depreciation")) metrics.depreciation += amount;
    if (name.includes("amortization")) metrics.amortization += amount;
    if (name.includes("interest expense")) metrics.interestExpense += amount;
    if (name.includes("interest income")) metrics.interestIncome += amount;
    if (name.includes("other expense")) metrics.otherExpenses += amount;
    if (name === "total expenses") metrics.totalExpenses = amount;
    if (name === "net income") metrics.netIncome = amount;
  });
}

function collectTravelMealsFromGL(rows) {
  let total = 0;

  rows.forEach((row) => {
    const account = rowName(row).toLowerCase();
    if (
      !account.includes("travel") &&
      !account.includes("meal") &&
      !account.includes("entertainment")
    ) {
      return;
    }

    row?.Rows?.Row?.forEach((entry) => {
      total += toNumber(entry?.ColData?.[1]?.value);
    });
  });

  return total;
}

function collectAdjustmentsFromJournals(entries) {
  const adjustments = {
    badDebt: 0,
    charitableDonations: 0,
    other: 0,
  };

  entries.forEach((entry) => {
    entry?.Line?.forEach((line) => {
      const amount = toNumber(line?.Amount);
      const account =
        line?.JournalEntryLineDetail?.AccountRef?.name?.toLowerCase() || "";

      if (account.includes("bad debt")) {
        adjustments.badDebt += amount;
        return;
      }

      if (
        account.includes("charitable") ||
        account.includes("donation") ||
        account.includes("contribution")
      ) {
        adjustments.charitableDonations += amount;
        return;
      }

      adjustments.other += amount;
    });
  });

  return adjustments;
}

async function runQBGet(clientId, qb, pathAndQuery) {
  const headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };

  const url = `${qb.baseUrl}/v3/company/${qb.realmId}${pathAndQuery}`;

  for (let attempt = 0; attempt <= QB_MAX_RETRIES; attempt += 1) {
    try {
      return await axios.get(url, {
        headers,
        timeout: 15000,
      });
    } catch (error) {
      const status = error.response?.status;

      if (status === 401) {
        const refreshedAccessToken =
          await tokenManager.refreshAccessToken(clientId);

        headers.Authorization = `Bearer ${refreshedAccessToken}`;
        continue;
      }

      if (status === QB_THROTTLE_STATUS && attempt < QB_MAX_RETRIES) {
        const retryAfterHeader = Number.parseInt(
          error.response?.headers?.["retry-after"],
          10,
        );
        const waitMs = Number.isFinite(retryAfterHeader)
          ? retryAfterHeader * 1000
          : 1000 * (attempt + 1);

        await sleep(waitMs);
        continue;
      }

      throw error;
    }
  }

  throw new Error("QuickBooks request failed after retries.");
}

async function buildYearSummary({
  clientId,
  qb,
  fiscalYear,
  accountingMethod,
}) {
  const startDate = `${fiscalYear}-01-01`;
  const endDate = `${fiscalYear}-12-31`;
  const reportAccountingMethod =
    String(accountingMethod).toLowerCase() === "cash" ? "Cash" : "Accrual";

  const plResponse = await runQBGet(
    clientId,
    qb,
    `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&accounting_method=${reportAccountingMethod}`,
  );
  await sleep(QB_REQUEST_DELAY_MS);

  const journalResponse = await runQBGet(
    clientId,
    qb,
    `/query?query=${encodeURIComponent(
      `SELECT * FROM JournalEntry WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}'`,
    )}`,
  );
  await sleep(QB_REQUEST_DELAY_MS);

  const glResponse = await runQBGet(
    clientId,
    qb,
    `/reports/GeneralLedger?start_date=${startDate}&end_date=${endDate}&accounting_method=${reportAccountingMethod}`,
  );

  const plMetrics = {
    depreciation: 0,
    amortization: 0,
    interestExpense: 0,
    interestIncome: 0,
    otherExpenses: 0,
    totalExpenses: 0,
    netIncome: 0,
  };

  accumulatePLRows(plResponse.data?.Rows?.Row || [], plMetrics);

  if (!plMetrics.otherExpenses && plMetrics.totalExpenses) {
    plMetrics.otherExpenses = plMetrics.totalExpenses;
  }

  const adjustments = collectAdjustmentsFromJournals(
    journalResponse.data?.QueryResponse?.JournalEntry || [],
  );
  const travelMeals = collectTravelMealsFromGL(glResponse.data?.Rows?.Row || []);

  const cimNetIncome =
    plMetrics.netIncome +
    plMetrics.depreciation +
    plMetrics.amortization +
    adjustments.badDebt +
    adjustments.charitableDonations;

  const taxReturnNetIncome = cimNetIncome + 20000;
  const netIncomeVariance = taxReturnNetIncome - cimNetIncome;

  const taxToBookItems = {
    interestIncomePerTaxReturns: plMetrics.interestIncome,
    sec179Depreciation: 0,
    charitableDonations: adjustments.charitableDonations,
    post1986Depreciation: 0,
    nondeductibleMeals: travelMeals,
    changeInAccountsReceivable: 0,
    accountsReceivableRetentions: 0,
    changeInAP: 0,
    badDebtWriteOffs: adjustments.badDebt,
    other: adjustments.other,
  };

  const taxToBookReconciliationCheck =
    Object.values(taxToBookItems).reduce((sum, value) => sum + value, 0) -
    netIncomeVariance;

  const additionalSdeAddbacks = {
    depreciationExpense: plMetrics.depreciation,
    amortizationExpense: plMetrics.amortization,
    totalInterestExpense: plMetrics.interestExpense,
    travelMealsEntertainment: travelMeals,
    badDebtExpense: adjustments.badDebt,
    charitableDonations: adjustments.charitableDonations,
    other: adjustments.other,
  };

  const sellerDiscretionaryEarnings =
    plMetrics.netIncome +
    Object.values(additionalSdeAddbacks).reduce((sum, value) => sum + value, 0);

  return {
    fiscalYear,
    startDate,
    endDate,
    pl: {
      depreciationExpense: plMetrics.depreciation,
      amortizationExpense: plMetrics.amortization,
      totalInterestExpense: plMetrics.interestExpense,
      totalInterestIncome: plMetrics.interestIncome,
      allOtherExpenses: plMetrics.otherExpenses,
      netIncome: plMetrics.netIncome,
    },
    cim: {
      netIncome: cimNetIncome,
      sellerDiscretionaryEarnings,
    },
    taxReturn: {
      netIncome: taxReturnNetIncome,
      interestIncomePerTaxReturns: taxToBookItems.interestIncomePerTaxReturns,
    },
    variance: {
      netIncome: netIncomeVariance,
      sellerDiscretionaryEarnings:
        taxReturnNetIncome - sellerDiscretionaryEarnings,
    },
    taxToBookItems: {
      ...taxToBookItems,
      reconciliationCheck: taxToBookReconciliationCheck,
    },
    additionalSdeAddbacks,
    raw: {
      travelMeals,
      badDebt: adjustments.badDebt,
      charitableDonations: adjustments.charitableDonations,
      otherAdjustments: adjustments.other,
    },
  };
}

router.get("/tax-reconciliation", async (req, res) => {
  try {
    const clientId =
      req.clientId || req.query.clientId || req.headers["x-client-id"];
    const qb = req.qb;

    if (!clientId || !qb?.accessToken || !qb?.realmId) {
      return res.status(401).json({
        success: false,
        error: "QuickBooks is not connected for this company.",
      });
    }

    const comparisonEndYear = Number.parseInt(
      req.query.comparison_end_year,
      10,
    );
    const currentYear = new Date().getFullYear();
    const endYear =
      Number.isFinite(comparisonEndYear) && comparisonEndYear > 2000
        ? Math.min(comparisonEndYear, currentYear)
        : currentYear;
    const accountingMethod =
      String(req.query.accounting_method || "accrual").toLowerCase() ===
      "cash"
        ? "Cash"
        : "Accrual";

    const fiscalYears = [endYear - 1, endYear];
    const years = [];

    for (const fiscalYear of fiscalYears) {
      years.push(
        await buildYearSummary({
          clientId,
          qb,
          fiscalYear,
          accountingMethod,
        }),
      );
      await sleep(QB_REQUEST_DELAY_MS);
    }

    const latestYear = years[years.length - 1];

    res.json({
      success: true,
      companyName: qb.companyName || null,
      accountingMethod,
      years,
      currentYear: latestYear,
      comparisonEndYear: endYear,
      requestedComparisonEndYear: comparisonEndYear || null,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const statusCode =
      err.response?.status === QB_THROTTLE_STATUS ? QB_THROTTLE_STATUS : 500;

    res.status(statusCode).json({
      success: false,
      error: "Failed to generate tax reconciliation",
      details: err.response?.data || err.message,
    });
  }
});

module.exports = router;
