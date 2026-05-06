const express = require("express");
const axios = require("axios");

const router = express.Router();

// ==========================
// 🔗 CONFIG
// ==========================
const BASE_URL = "https://quickbooks.api.intuit.com";

// ==========================
// 📊 FETCH QUICKBOOKS DATA
// ==========================
async function getProfitAndLoss(realmId, accessToken, baseUrl, startDate, endDate) {
    const url = `${baseUrl}/v3/company/${realmId}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&minorversion=65`;

    const response = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
        },
    });

    return response.data;
}

async function getBalanceSheet(realmId, accessToken, baseUrl, startDate, endDate) {
    const url = `${baseUrl}/v3/company/${realmId}/reports/BalanceSheet?start_date=${startDate}&end_date=${endDate}&minorversion=65`;

    const response = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
        },
    });

    return response.data;
}

// ==========================
// 🧠 VALUATION LOGIC
// ==========================

// Extract EBITDA
function extractEBITDA(pnl) {
    let netIncome = 0;
    let depreciation = 0;
    let interestExpense = 0;
    let taxes = 0;

    const getName = (r) => (r?.Summary?.ColData?.[0]?.value || r?.Header?.ColData?.[0]?.value || r?.ColData?.[0]?.value || "").toLowerCase().trim();
    const getVal = (r) => Number(r?.Summary?.ColData?.[1]?.value || r?.ColData?.[1]?.value || 0);

    function loop(rows) {
        if (!rows || !Array.isArray(rows)) return;
        rows.forEach((r) => {
            if (r?.Rows?.Row) loop(r.Rows.Row);
            const name = getName(r);
            const val = getVal(r);
            if (!name) return;

            if (name === "net income") netIncome += val;
            else if (name.includes("depreciation") || name.includes("amortization")) depreciation += val;
            else if (name.includes("interest") && (name.includes("expense") || name === "interest")) interestExpense += val;
            else if (name.includes("tax") && !name.includes("payroll")) taxes += val;
        });
    }

    loop(pnl?.Rows?.Row);
    return netIncome + depreciation + interestExpense + taxes;
}

// Extract Debt & Cash
function extractBalanceSheet(bs) {
    let debt = 0;
    let cash = 0;

    const getName = (r) => (r?.Summary?.ColData?.[0]?.value || r?.Header?.ColData?.[0]?.value || r?.ColData?.[0]?.value || "").toLowerCase().trim();
    const getVal = (r) => Number(r?.Summary?.ColData?.[1]?.value || r?.ColData?.[1]?.value || 0);

    function loop(rows) {
        if (!rows || !Array.isArray(rows)) return;
        rows.forEach((r) => {
            if (r?.Rows?.Row) loop(r.Rows.Row);
            const name = getName(r);
            const val = getVal(r);
            if (!name) return;

            if (name === "total liabilities" || name === "total liabilities and equity") {
                if (name === "total liabilities") debt = val; // Prioritize explicit total liabilities
            } else if (name.includes("liability") || name.includes("debt") || name.includes("loan")) {
                if (!debt && val > 0) debt += val; // Fallback if no total liabilities row matches exactly
            }

            if (name === "total bank accounts" || name === "cash and cash equivalents" || name === "checking" || name === "savings") {
                cash += val;
            }
        });
    }

    loop(bs?.Rows?.Row);
    return { debt, cash };
}

// EBITDA Multiple Valuation
function calculateEBITDAValuation(ebitda, multiple, debt, cash) {
    const enterpriseValue = ebitda * multiple;
    const equityValue = enterpriseValue - debt + cash;

    return { enterpriseValue, equityValue };
}

// DCF Valuation
function calculateDCF(cashFlows, discountRate) {
    return cashFlows.reduce((acc, cf, i) => {
        return acc + cf / Math.pow(1 + discountRate, i + 1);
    }, 0);
}

// Benchmark Valuation
function calculateBenchmark(ebitda, industryMultiple) {
    return ebitda * industryMultiple;
}

// ==========================
// 🚀 API ROUTE
// ==========================
router.post("/valuation", async (req, res) => {
    try {
        const { realmId, accessToken, baseUrl } = req.qb || {};
        const startDate = req.body.startDate || "2023-01-01";
        const endDate = req.body.endDate || "2023-12-31";

        if (!realmId || !accessToken) {
            return res.status(400).json({
                error: "realmId and accessToken are required",
            });
        }

        // Fetch data
        const pnl = await getProfitAndLoss(realmId, accessToken, baseUrl, startDate, endDate);
        const bs = await getBalanceSheet(realmId, accessToken, baseUrl, startDate, endDate);

        // Extract values
        const ebitda = extractEBITDA(pnl);
        const { debt, cash } = extractBalanceSheet(bs);

        // Calculations
        const ebitdaMultiple = req.body.ebitdaMultiple || 8;
        const discountRate = req.body.discountRate || 0.1;
        const benchmarkMultiple = req.body.benchmarkMultiple || 7;

        const ebitdaVal = calculateEBITDAValuation(ebitda, ebitdaMultiple, debt, cash);

        const dcfVal = calculateDCF(
            [ebitda, ebitda * 1.1, ebitda * 1.2],
            discountRate
        );

        const benchmarkVal = calculateBenchmark(ebitda, benchmarkMultiple);

        const finalValue =
            (ebitdaVal.equityValue + dcfVal + benchmarkVal) / 3;

        // Response
        res.json({
            success: true,
            data: {
                ebitda,
                debt,
                cash,
                assumptions: {
                    ebitdaMultiple,
                    discountRate,
                    benchmarkMultiple
                },
                ebitdaValuation: ebitdaVal,
                dcfValue: dcfVal,
                benchmarkValue: benchmarkVal,
                finalEstimate: finalValue,
            },
        });
    } catch (error) {
        console.error("Valuation Error:", error.response?.data || error.message);

        res.status(500).json({
            success: false,
            error: error.response?.data || error.message,
        });
    }
});

module.exports = router;