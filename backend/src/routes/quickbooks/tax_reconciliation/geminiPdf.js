const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const tokenManager = require("../../../tokenManager");

const router = express.Router();

/* ===========================
   CONFIG
=========================== */
const DEFAULT_PDF_PATH =
  process.env.GEMINI_PDF_TEST_PATH ||
  "C:\\Users\\adiko\\Downloads\\Example QoE Documents\\Example QoE Documents\\Tax Return\\2022 Tax Return.pdf";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/* ===========================
   QUICKBOOKS CALL
=========================== */
async function runQBGet(clientId, qb, url) {
  let headers = {
    Authorization: `Bearer ${qb.accessToken}`,
    Accept: "application/json",
  };

  try {
    return await axios.get(url, { headers });
  } catch (err) {
    if (err.response?.status === 401) {
      const newToken = await tokenManager.refreshAccessToken(clientId);
      headers.Authorization = `Bearer ${newToken}`;
      return await axios.get(url, { headers });
    }
    throw err;
  }
}

/* ===========================
   PARSE QB P&L
=========================== */
function extractPL(rows) {
  const result = {
    totalRevenue: 0,
    totalCostOfGoodsSold: 0,
    grossProfit: 0,
    officerWages: 0,
    depreciation: 0,
    amortization: 0,
    interestExpense: 0,
    interestIncome: 0,
    otherExpenses: 0,
    netIncome: 0,
  };

  const getName = (r) =>
    r?.Header?.ColData?.[0]?.value || r?.ColData?.[0]?.value || "";

  const getVal = (r) =>
    Number(r?.ColData?.[1]?.value || r?.Summary?.ColData?.[1]?.value || 0);

  function loop(rows) {
    rows.forEach((r) => {
      if (r.Rows?.Row) loop(r.Rows.Row);

      const name = getName(r).toLowerCase();
      const val = getVal(r);

      if (name.includes("total income")) result.totalRevenue = val;
      if (name.includes("cost of goods")) result.totalCostOfGoodsSold = val;
      if (name === "gross profit") result.grossProfit = val;
      if (name.includes("officer")) result.officerWages += val;
      if (name.includes("depreciation")) result.depreciation += val;
      if (name.includes("amortization")) result.amortization += val;
      if (name.includes("interest expense")) result.interestExpense += val;
      if (name.includes("interest income")) result.interestIncome += val;
      if (name.includes("other expense")) result.otherExpenses += val;
      if (name === "net income") result.netIncome = val;
    });
  }

  loop(rows);
  return result;
}

/* ===========================
   GEMINI EXTRACTION
=========================== */
async function extractTaxFromPDF(filePath) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL });

  const pdfBuffer = fs.readFileSync(filePath);

  const prompt = `
Extract ONLY these fields from Form 1120-S:

Return JSON:

{
  "totalRevenue": number,
  "totalCostOfGoodsSold": number,
  "grossProfit": number,
  "officerWages": number,
  "depreciation": number,
  "amortization": number,
  "interestExpense": number,
  "interestIncome": number,
  "allOtherExpenses": number,
  "netIncome": number
}
`;

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: "application/pdf",
        data: pdfBuffer.toString("base64"),
      },
    },
    { text: prompt },
  ]);

  let text = result.response.text();

  text = text.replace(/```json|```/g, "").trim();

  return JSON.parse(text);
}

/* ===========================
   MAIN API
=========================== */
router.get("/reconciliation-matrix", async (req, res) => {
  try {
    const clientId =
      req.clientId || req.query.clientId || req.headers["x-client-id"];
    const qb = req.qb;

    if (!qb?.accessToken) {
      return res.status(401).json({ error: "QB not connected" });
    }

    const startDate = req.query.start_date || "2024-01-01";
    const endDate = req.query.end_date || "2024-12-31";

    /* ===== QUICKBOOKS ===== */
    const qbRes = await runQBGet(
      clientId,
      qb,
      `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&accounting_method=Accrual`,
    );

    const pl = extractPL(qbRes.data.Rows.Row);

    /* ===== GEMINI ===== */
    const tax = await extractTaxFromPDF(DEFAULT_PDF_PATH);

    /* ===== FINAL UI RESPONSE ===== */
    const rows = [
      "Total Revenue",
      "Total Cost of Goods Sold",
      "Gross Profit",
      "Officer Wages",
      "Depreciation Expense",
      "Amortization Expense",
      "Total Interest Expense",
      "Total Interest Income",
      "All Other Expenses",
      "Net Income",
    ];

    const map = {
      "Total Revenue": ["totalRevenue"],
      "Total Cost of Goods Sold": ["totalCostOfGoodsSold"],
      "Gross Profit": ["grossProfit"],
      "Officer Wages": ["officerWages"],
      "Depreciation Expense": ["depreciation"],
      "Amortization Expense": ["amortization"],
      "Total Interest Expense": ["interestExpense"],
      "Total Interest Income": ["interestIncome"],
      "All Other Expenses": ["otherExpenses", "allOtherExpenses"],
      "Net Income": ["netIncome"],
    };

    const data = rows.map((label) => {
      const key = map[label];

      const plVal = pl[key[0]] || 0;
      const taxVal = tax[key[1] || key[0]] || 0;

      return {
        label,
        pl: plVal,
        taxReturn: taxVal,
        variance: taxVal - plVal,
      };
    });

    return res.json({
      success: true,
      startDate,
      endDate,
      data,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
