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
  const url = `${qb.baseUrl}/v3/company/${qb.realmId}/customer?minorversion=75`;

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
  const { serveCachedReport, REPORT_TYPES } = require("../../../services/quickbooksReportService");

  try {
    const cached = await serveCachedReport(
      req.clientId,
      REPORT_TYPES.CUSTOMERS,
      {
        startposition: req.query.startposition,
        maxresults: req.query.maxresults,
      },
      { disconnected: Boolean(req.qbDisconnected) },
    );

    if (!cached?.data) {
      return res.status(404).json({
        success: false,
        source: "cached_snapshot",
        disconnected: Boolean(req.qbDisconnected),
        message: "No finalized customer snapshot is available. Run QuickBooks sync to refresh cached data.",
      });
    }

    return res.json({
      success: true,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      lastSyncAt: cached.lastSyncedAt,
      datasetVersion: cached.datasetVersion || null,
      data: cached.data,
    });
  } catch (error) {
    console.error("[Customers] Snapshot read failed:", error.message);
    return res.status(500).json({
      success: false,
      source: "cached_snapshot",
      disconnected: Boolean(req.qbDisconnected),
      message: "Failed to load customer snapshot.",
      error: error.message,
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
module.exports = router;

