const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");

const router = express.Router();

/**
 * @swagger
 * /customers:
 *   post:
 *     summary: Create Customer in QuickBooks
 *     description: Creates a new customer in QuickBooks only
 *     tags:
 *       - Customers
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               phone:
 *                 type: string
 *               address:
 *                 type: string
 *               notes:
 *                 type: string
 */

router.post("/customers", async (req, res) => {
  const qb = getQBConfig(req.clientId);

  if (!qb.accessToken || !qb.realmId) {
    return res.status(401).json({ error: "Missing QuickBooks configuration" });
  }

  try {
    // Handling both mapped and unmapped incoming structures
    const name = req.body.name || req.body.DisplayName;
    const email = req.body.email || req.body.PrimaryEmailAddr?.Address;
    const phone = req.body.phone || req.body.PrimaryPhone?.FreeFormNumber;
    const address = req.body.address || req.body.BillAddr?.Line1;
    const notes = req.body.notes || req.body.Notes;

    if (!name)
      return res.status(400).json({ error: "Client name is required" });

    const qbPayload = {
      DisplayName: name,
      PrimaryEmailAddr: email ? { Address: email } : undefined,
      PrimaryPhone: phone ? { FreeFormNumber: phone } : undefined,
      BillAddr: address ? { Line1: address } : undefined,
      Notes: notes,
    };

    // Ensure baseUrl is an absolute URL (e.g., https://sandbox-quickbooks.api.intuit.com)
    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/customer?minorversion=75`;

    const qbResponse = await axios.post(url, qbPayload, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    // QuickBooks returns the object inside qbResponse.data.Customer
    res.json({
      success: true,
      message: "Customer created successfully",
      customer: qbResponse.data.Customer, // Return the actual created object
    });
  } catch (error) {
    const errorDetails = error.response?.data || error.message;
    console.error("QuickBooks create customer error:", errorDetails);

    // Check for "Duplicate Name" error (Code 6240)
    const isDuplicate = JSON.stringify(errorDetails).includes("6240");
    res.status(error.response?.status || 500).json({
      error: isDuplicate
        ? "A client with this name already exists in QuickBooks"
        : "Failed to create customer",
      details: errorDetails,
    });
  }
});

/**
 * @swagger
 * /customers:
 *   get:
 *     summary: Get Customers
 *     description: Retrieves a list of customers from QuickBooks with pagination
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
 *     responses:
 *       200:
 *         description: Customers retrieved successfully
 *       400:
 *         description: Missing QuickBooks configuration
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.get("/customers", async (req, res) => {
  // If QB is disconnected, serve cached data
  if (req.qbDisconnected) {
    try {
      const { serveCachedReport } = require("../../../services/quickbooksReportService");
      const cached = await serveCachedReport(req.clientId, "customers");
      if (cached) {
        return res.json({
          ...cached.data,
          _meta: { source: "cache", lastSyncedAt: cached.lastSyncedAt, isDisconnected: true },
        });
      }
      return res.status(404).json({
        error: "QuickBooks is disconnected and no cached customer data is available.",
        isDisconnected: true,
      });
    } catch (cacheError) {
      return res.status(500).json({ error: "Failed to retrieve cached data." });
    }
  }

  const qb = getQBConfig(req.clientId);

  // Validate QuickBooks configuration
  if (!qb.accessToken || !qb.realmId) {
    return res.status(400).json({
      error: "Missing QuickBooks configuration. Please authenticate first.",
    });
  }

  let { startposition, maxresults } = req.query;

  console.log("=".repeat(60));
  console.log("👥 CUSTOMERS REQUEST");
  console.log("=".repeat(60));
  console.log(
    `📌 Start Position: ${startposition || "Not specified (default: 1)"}`,
  );
  console.log(
    `📊 Max Results: ${maxresults || "Not specified (default: 100)"}`,
  );
  console.log("=".repeat(60));

  // Set defaults and validate
  const startPos = parseInt(startposition) || 1;
  const maxRes = Math.min(parseInt(maxresults) || 100, 1000); // Max 1000 per QuickBooks limit

  // Build the query
  const query = `SELECT * FROM Customer STARTPOSITION ${startPos} MAXRESULTS ${maxRes}`;

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

    console.log("✅ Customers fetched successfully!");

    // Log summary
    if (response.data && response.data.QueryResponse) {
      const customerCount = response.data.QueryResponse.Customer?.length || 0;
      const totalCount = response.data.QueryResponse.totalCount || 0;
      console.log(
        `📊 Retrieved ${customerCount} customers out of ${totalCount} total`,
      );
    }

    // Cache the response for offline access
    const { upsertSyncedReport } = require("../../../services/quickbooksSyncStore");
    upsertSyncedReport({
      companyId: req.clientId,
      reportType: "customers",
      reportParams: { startposition: startPos, maxresults: maxRes },
      data: response.data,
    }).catch(err => console.error("[Customers] Cache failed:", err.message));

    // Return raw QuickBooks response
    return res.json(response.data);
  } catch (error) {
    console.error("❌ Customers API Error:", error.message);

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
      error: "Failed to fetch customers",
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /customers/query:
 *   post:
 *     summary: Execute Custom Query
 *     description: Executes a custom QuickBooks SQL-like query
 *     requestBody:
 *       required: true
 *       content:
 *         text/plain:
 *           schema:
 *             type: string
 *           examples:
 *             customers:
 *               summary: Get Customers
 *               value: "SELECT * FROM Customer STARTPOSITION 1 MAXRESULTS 10"
 *             invoices:
 *               summary: Get Invoices
 *               value: "SELECT * FROM Invoice STARTPOSITION 1 MAXRESULTS 10"
 *     responses:
 *       200:
 *         description: Query executed successfully
 *       400:
 *         description: Missing QuickBooks configuration
 *       401:
 *         description: Authentication failed
 *       500:
 *         description: Server error
 */
router.post("/customers/query", async (req, res) => {
  const qb = getQBConfig(req.clientId);

  // Validate QuickBooks configuration
  if (!qb.accessToken || !qb.realmId) {
    return res.status(400).json({
      error: "Missing QuickBooks configuration. Please authenticate first.",
    });
  }

  let query = req.body;

  // If query is sent as JSON string, extract it
  if (typeof query === "object" && query.query) {
    query = query.query;
  }

  console.log("=".repeat(60));
  console.log("🔍 CUSTOM QUERY REQUEST");
  console.log("=".repeat(60));
  console.log(`📝 Query: ${query}`);
  console.log("=".repeat(60));

  if (!query || typeof query !== "string") {
    return res.status(400).json({
      error: "Invalid query. Please provide a valid query string.",
    });
  }

  try {
    const url = `${qb.baseUrl}/v3/company/${qb.realmId}/query?minorversion=75`;

    const response = await axios.post(url, query, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/text",
        "User-Agent": "QuickBooks-Integration/1.0",
      },
    });

    console.log("✅ Query executed successfully!");

    // Return raw QuickBooks response
    return res.json(response.data);
  } catch (error) {
    console.error("❌ Query API Error:", error.message);

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

          const retryResponse = await axios.post(url, query, {
            headers: {
              Authorization: `Bearer ${newAccessToken}`,
              Accept: "application/json",
              "Content-Type": "application/text",
              "User-Agent": "QuickBooks-Integration/1.0",
            },
          });

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
      error: "Failed to execute query",
      details: error.message,
    });
  }
});

/**
 * @swagger
 * /api/customers/{id}:
 *   post:
 *     summary: Update Customer
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Customer updated successfully
 */
router.put("/api/customers/:id", async (req, res) => {
  const qb = getQBConfig(req.clientId);

  // 1. Auth check
  if (!qb.accessToken || !qb.realmId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const { id } = req.params;
  const updateData = req.body;

  try {
    const fetchUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/customer/${id}?minorversion=75`;

    let fetchResponse;

    // 2. Fetch existing customer (for SyncToken)
    try {
      fetchResponse = await axios.get(fetchUrl, {
        headers: {
          Authorization: `Bearer ${qb.accessToken}`,
          Accept: "application/json",
        },
      });
    } catch (error) {
      // Handle token expiry
      if (error.response?.status === 401) {
        const newAccessToken = await tokenManager.refreshAccessToken(
          req.clientId,
        );

        fetchResponse = await axios.get(fetchUrl, {
          headers: {
            Authorization: `Bearer ${newAccessToken}`,
            Accept: "application/json",
          },
        });

        // 🔥 update token in config (IMPORTANT)
        qb.accessToken = newAccessToken;
      } else {
        throw error;
      }
    }

    const existingCustomer = fetchResponse.data.Customer;

    if (!existingCustomer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    // 3. 🔥 MAP FRONTEND → QUICKBOOKS FORMAT
    const payload = {
      Id: existingCustomer.Id,
      SyncToken: existingCustomer.SyncToken,
      sparse: true,

      // ✅ Only send valid QuickBooks fields
      ...(updateData.name && { DisplayName: updateData.name }),

      ...(updateData.email && {
        PrimaryEmailAddr: {
          Address: updateData.email,
        },
      }),

      ...(updateData.phone && {
        PrimaryPhone: {
          FreeFormNumber: updateData.phone,
        },
      }),
    };

    // 4. Update customer in QuickBooks
    const updateUrl = `${qb.baseUrl}/v3/company/${qb.realmId}/customer?minorversion=75`;

    const updateResponse = await axios.post(updateUrl, payload, {
      headers: {
        Authorization: `Bearer ${qb.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    // 5. Success response
    return res.json({
      success: true,
      data: updateResponse.data.Customer,
    });
  } catch (error) {
    console.error(
      "❌ Update Customer Error:",
      error.response?.data || error.message,
    );

    const statusCode = error.response?.status || 500;
    const qbError = error.response?.data?.Fault?.Error?.[0];

    return res.status(statusCode).json({
      success: false,
      message: qbError?.Message || error.message,
      code: qbError?.code,
      details: qbError?.Detail,
    });
  }
});

module.exports = router;
