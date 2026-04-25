const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");

const router = express.Router();

// async function runQBGet(clientId, qb, url) {
//   let headers = {
//     Authorization: `Bearer ${qb.accessToken}`,
//     Accept: "application/json",
//   };

//   try {
//     return await axios.get(url, { headers });
//   } catch (err) {
//     if (err.response?.status === 401) {
//       const newToken = await tokenManager.refreshAccessToken(clientId);
//       headers.Authorization = `Bearer ${newToken}`;
//       return await axios.get(url, { headers });
//     }
//     throw err;
//   }
// }

// router.get("/tax-profit-and-loss", async (req, res) => {
//   try {
//     const clientId =
//       req.clientId || req.query.clientId || req.headers["x-client-id"];
//     const qb = req.qb;

//     if (!clientId || !qb?.accessToken || !qb?.realmId) {
//       return res.status(401).json({
//         success: false,
//         error: "QuickBooks not connected",
//       });
//     }

//     // ✅ DATE FILTER
//     const startDate = req.query.start_date || "2024-01-01";
//     const endDate = req.query.end_date || "2024-12-31";

//     // ✅ DEFAULT = ACCRUAL
//     const accountingMethod =
//       String(req.query.accounting_method || "accrual").toLowerCase() === "cash"
//         ? "Cash"
//         : "Accrual";

//     const url = `${qb.baseUrl}/v3/company/${qb.realmId}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&accounting_method=${accountingMethod}`;

//     const response = await runQBGet(clientId, qb, url);

//     return res.json({
//       success: true,
//       companyName: qb.companyName || null,
//       startDate,
//       endDate,
//       accountingMethod,
//       data: response.data,
//     });
//   } catch (err) {
//     return res.status(500).json({
//       success: false,
//       error: err.message,
//     });
//   }
// });

module.exports = router;
