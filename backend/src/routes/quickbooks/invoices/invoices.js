const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");

const router = express.Router();

/**
 * @swagger
 * /invoices:
 *   get:
 *     summary: Get Invoices
 *     description: Retrieves a list of invoices from QuickBooks with pagination
 *     parameters:
 *       - in: query
 *         name: startposition
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Starting position for pagination
 *         required: false
 *         example: 1
 *       - in: query
 *         name: maxresults
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 1000
 *         description: Maximum number of results to return (max 1000)
 *         required: false
 *         example: 5
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [All, Paid, Unpaid, Overdue]
 *         description: Filter invoices by status
 *         required: false
 *         example: All
 *     responses:
 *       200:
 *         description: Invoices retrieved successfully
 *       400:
 *         description: Missing QuickBooks configuration
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.get("/invoices", async (req, res) => {
  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const { serveCachedReport } = require("../../../services/quickbooksReportService");
      const cached = await serveCachedReport(req.clientId, "invoices");
      if (cached) {
        return res.json({
          ...cached.data,
          _meta: { source: "cache", lastSyncedAt: cached.lastSyncedAt, isDisconnected: true },
        });
      }
      return res.status(404).json({
        error: "QuickBooks is disconnected and no cached invoice data is available.",
        isDisconnected: true,
      });
    } catch (cacheError) {
      return res.status(500).json({ error: "Failed to retrieve cached data." });
    }
  }

  const qb = getQBConfig(req.clientId);

  let { startposition, maxresults, status } = req.query;

  console.log("=".repeat(60));
  console.log("📄 INVOICES REQUEST");
  console.log("=".repeat(60));
  console.log(
    `📌 Start Position: ${startposition || "Not specified (default: 1)"}`,
  );
  console.log(
    `📊 Max Results: ${maxresults || "Not specified (default: 100)"}`,
  );
  console.log(`📌 Status Filter: ${status || "Not specified (default: All)"}`);
  console.log("=".repeat(60));

  // Set defaults and validate
  const startPos = parseInt(startposition) || 1;
  const maxRes = Math.min(parseInt(maxresults) || 100, 1000); // Max 1000 per QuickBooks limit

  // Build the query
  let query = `SELECT * FROM Invoice STARTPOSITION ${startPos} MAXRESULTS ${maxRes}`;

  // Add status filter if provided
  if (status && status !== "All") {
    if (status === "Paid") {
      query = `SELECT * FROM Invoice WHERE Balance = 0 STARTPOSITION ${startPos} MAXRESULTS ${maxRes}`;
    } else if (status === "Unpaid") {
      query = `SELECT * FROM Invoice WHERE Balance > 0 STARTPOSITION ${startPos} MAXRESULTS ${maxRes}`;
    } else if (status === "Overdue") {
      query = `SELECT * FROM Invoice WHERE Balance > 0 AND DueDate < '{current_date}' STARTPOSITION ${startPos} MAXRESULTS ${maxRes}`;
    }
  }

  console.log(`🔍 Query: ${query}`);

  try {
    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/query?minorversion=75`;

    console.log(`🔗 URL: ${url}`);
    console.log(`📝 Query: ${query}`);

    const response = await axios.post(url, query, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/text",
        "User-Agent": "QuickBooks-Integration/1.0",
      },
    });

    console.log("✅ Invoices fetched successfully!");

    // Log summary
    if (response.data && response.data.QueryResponse) {
      const invoiceCount = response.data.QueryResponse.Invoice?.length || 0;
      const totalCount = response.data.QueryResponse.totalCount || 0;
      console.log(
        `📊 Retrieved ${invoiceCount} invoices out of ${totalCount} total`,
      );

      // Calculate total amount if invoices exist
      if (invoiceCount > 0) {
        let totalAmount = 0;
        response.data.QueryResponse.Invoice.forEach((invoice) => {
          totalAmount += parseFloat(invoice.TotalAmt || 0);
        });
        console.log(`💰 Total Amount: $${totalAmount.toFixed(2)}`);
      }
    }

    // Cache the response for offline access
    const { upsertSyncedReport } = require("../../../services/quickbooksSyncStore");
    upsertSyncedReport({
      companyId: req.clientId,
      reportType: "invoices",
      reportParams: { startposition: startPos, maxresults: maxRes, status },
      data: response.data,
    }).catch(err => console.error("[Invoices] Cache failed:", err.message));

    // Return raw QuickBooks response
    return res.json(response.data);
  } catch (error) {
    console.error("❌ Invoices API Error:", error.message);

    if (error.response) {
      console.error("📝 Status Code:", error.response.status);
      console.error(
        "📝 Response Data:",
        JSON.stringify(error.response.data, null, 2),
      );

      // Handle 401 Unauthorized - Token expired
      if (error.response.status === 401) {
        console.log("⚠️ Token expired, attempting to refresh...");

        try {
          const newAccessToken = await tokenManager.refreshAccessToken(
            req.clientId,
          );
          console.log("✅ Token refreshed successfully!");

          const retryResponse = await axios.post(
            `${qb.baseUrl}/v3/company/${qb.realmId}/query?minorversion=75`,
            query,
            {
              headers: {
                Authorization: `Bearer ${newAccessToken}`,
                Accept: "application/json",
                "Content-Type": "application/text",
                "User-Agent": "QuickBooks-Integration/1.0",
              },
            },
          );

          console.log("✅ Retry successful with new token!");
          return res.json(retryResponse.data);
        } catch (refreshError) {
          console.error("❌ Token refresh failed:", refreshError.message);
          return res.status(401).json({
            error: "Authentication failed. Please re-authenticate.",
            details: refreshError.message,
          });
        }
      }

      // Return the exact QuickBooks error response
      return res.status(error.response.status).json(error.response.data);
    }

    return res.status(500).json({
      error: "Failed to fetch invoices",
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /invoices/doc/{docNumber}:
 *   get:
 *     summary: Get Invoice by DocNumber
 *     description: Retrieves a specific invoice using DocNumber
 */
router.get("/invoices/doc/:docNumber", async (req, res) => {
  const qb = getQBConfig(req.clientId);

  if (!qb.accessToken || !qb.realmId) {
    return res.status(403).json({
      success: false,
      message: "QuickBooks not connected",
    });
  }

  const { docNumber } = req.params;

  console.log("=".repeat(60));
  console.log("📄 FETCH INVOICE BY DOC NUMBER");
  console.log(`📌 DocNumber: ${docNumber}`);
  console.log("=".repeat(60));

  // ✅ Correct query using DocNumber
  const query = `SELECT * FROM Invoice WHERE DocNumber = '${docNumber}'`;

  try {
    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/query?minorversion=75`;

    let response;

    try {
      response = await axios.post(url, query, {
        headers: {
          Authorization: `Bearer ${qb.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/text",
        },
      });
    } catch (error) {
      // 🔄 Handle token expiry
      if (error.response?.status === 401) {
        console.log("⚠️ Token expired, refreshing...");
        const newAccessToken = await tokenManager.refreshAccessToken(
          req.clientId,
        );

        response = await axios.post(url, query, {
          headers: {
            Authorization: `Bearer ${newAccessToken}`,
            Accept: "application/json",
            "Content-Type": "application/text",
          },
        });
      } else {
        throw error;
      }
    }

    const invoices = response.data.QueryResponse?.Invoice;

    // ❌ Not found
    if (!invoices || invoices.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No invoice found with DocNumber: ${docNumber}`,
      });
    }

    // ✅ Return first match (DocNumber is usually unique)
    return res.json({
      success: true,
      data: invoices[0],
    });
  } catch (error) {
    console.error("❌ Fetch Invoice by DocNumber Error:");
    console.error(error.response?.data || error.message);

    const qbError = error.response?.data?.Fault?.Error?.[0];

    return res.status(error.response?.status || 500).json({
      success: false,
      message: qbError?.Message || error.message,
      code: qbError?.code,
      details: qbError?.Detail,
    });
  }
});

/**
 * @swagger
 * /api/invoices/{id}:
 *   put:
 *     summary: Update Invoice in QuickBooks
 *     description: Safely updates an invoice by fetching the latest SyncToken first.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Invoice ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               PrivateNote:
 *                 type: string
 *               DueDate:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: Invoice updated successfully
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Invoice not found
 */
router.put("/api/invoices/:id", async (req, res) => {
  // 🔹 BLOCK COMPLEX UPDATES early
  const blockedFields = [
    "amount",
    "balance",
    "status",
    "date",
    "lineItems",
    "Line",
  ];
  const hasBlockedField = blockedFields.some(
    (field) => req.body[field] !== undefined,
  );
  const hasStringCustomer =
    req.body.customer !== undefined && typeof req.body.customer === "string";

  if (hasBlockedField || hasStringCustomer) {
    return res.status(400).json({
      success: false,
      message:
        "Complex invoice updates are not allowed via API. Please edit in QuickBooks.",
      redirectToQuickBooks: true,
    });
  }

  const qb = getQBConfig(req.clientId);

  if (!qb.accessToken || !qb.realmId) {
    return res.status(403).json({
      success: false,
      message: "QuickBooks not connected",
      isConnected: false,
    });
  }

  const { id } = req.params;
  let accessToken = qb.accessToken;

  try {
    // 1. Fetch latest invoice (REQUIRED for SyncToken)
    const fetchUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/invoice/${id}?minorversion=75`;
    let fetchResponse;

    try {
      fetchResponse = await axios.get(fetchUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
    } catch (error) {
      if (error.response?.status === 401) {
        accessToken = await tokenManager.refreshAccessToken(req.clientId);
        fetchResponse = await axios.get(fetchUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        });
      } else {
        throw error;
      }
    }

    const existingInvoice = fetchResponse.data.Invoice;
    if (!existingInvoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    // 🔹 SANITIZE REQUEST BODY
    const cleanBody = {
      invoiceNumber: req.body.invoiceNumber,
      dueDate: req.body.dueDate,
      note: req.body.note,
    };

    // 🔹 SAFE PAYLOAD
    const payload = {
      Id: existingInvoice.Id,
      SyncToken: existingInvoice.SyncToken,
      sparse: true,
    };

    if (cleanBody.invoiceNumber) {
      payload.DocNumber = String(cleanBody.invoiceNumber);
    }

    if (cleanBody.dueDate) {
      payload.DueDate = cleanBody.dueDate;
    }

    if (cleanBody.note) {
      payload.PrivateNote = cleanBody.note;
    }

    console.log("Filtered Payload:", payload);

    // Guard against empty updates to prevent QuickBooks ValidationFault
    if (Object.keys(payload).length <= 3) {
      return res.json({
        success: true,
        message: "No actionable fields were parsed for update.",
        data: existingInvoice,
      });
    }

    const updateUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/invoice?minorversion=75`;

    console.log(
      "🚀 QuickBooks Update Payload:",
      JSON.stringify(payload, null, 2),
    );

    const updateResponse = await axios.post(updateUrl, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    return res.json({
      success: true,
      data: updateResponse.data.Invoice,
    });
  } catch (error) {
    console.error("❌ QuickBooks Update Failed!");

    const qbError = error.response?.data?.Fault?.Error?.[0];

    return res.status(error.response?.status || 500).json({
      success: false,
      message: qbError?.Message || error.message,
      code: qbError?.code,
      details: qbError?.Detail,
    });
  }
});

module.exports = router;
