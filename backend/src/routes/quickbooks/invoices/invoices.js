const express = require("express");
const axios = require("axios");
const tokenManager = require("../../../tokenManager");
const { getQBConfig } = require("../../../qbconfig");

const router = express.Router();

function buildMonthlySummary(invoices) {
  const groups = {};

  for (const invoice of invoices) {
    const dateStr = invoice.TxnDate || invoice.date;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;

    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const key = `${year}-${String(month).padStart(2, "0")}`;

    if (!groups[key]) {
      groups[key] = {
        key, year, month,
        monthName: d.toLocaleString("en-US", { month: "long" }),
        invoiceCount: 0, invoiceAmount: 0, totalPostedAmount: 0, paidCount: 0,
      };
    }

    const amount = Number(invoice.TotalAmt || 0);
    const balance = Number(invoice.Balance || 0);
    groups[key].invoiceAmount += amount;
    groups[key].totalPostedAmount += Math.max(amount - balance, 0);
    groups[key].invoiceCount += 1;
    if (balance === 0) groups[key].paidCount += 1;
  }

  return Object.values(groups)
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
    .map((g) => ({
      key: g.key,
      year: g.year,
      month: g.month,
      monthName: g.monthName,
      invoiceCount: g.invoiceCount,
      invoiceAmount: g.invoiceAmount,
      totalPostedAmount: g.totalPostedAmount,
      paidCount: g.paidCount,
      avgPerInvoice: g.invoiceCount > 0 ? g.invoiceAmount / g.invoiceCount : 0,
      avgPerPaidInvoice: g.paidCount > 0 ? g.totalPostedAmount / g.paidCount : 0,
      clientFinalTotal: g.invoiceAmount,
    }));
}

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
/**
 * @swagger
 * /invoices/doc/{docNumber}:
 *   get:
 *     summary: Get Invoice by DocNumber
 *     description: Retrieves a specific invoice using DocNumber
 */

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


