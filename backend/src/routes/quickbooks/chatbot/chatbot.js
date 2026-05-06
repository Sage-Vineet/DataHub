const express = require("express");
const router = express.Router();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post("/", async (req, res) => {
  try {
    const { message } = req.body;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash"
    });

    const prompt = `
You are the DataHub AI Assistant. Your role is to help the user understand and navigate the DataHub platform, which is currently being developed.

Here is an overview of the application's key features to base your answers on:
1. DataRoom: A secure document management system to upload, organize, and store client files and reports.
2. Financial Trends: Real-time interactive charts visualizing QuickBooks financial metrics and KPIs.
3. Profit & Loss and Balance Sheet: Detailed financial reports dynamically synced directly from QuickBooks.
4. Customers Directory: A comprehensive directory of all synced customers with contact details.
5. Tax Reconciliation: Compares live QuickBooks financial data against extracted PDF tax forms (e.g., Form 1120S) using AI to highlight variances.
6. Bank Reconciliation: Automatically verifies QuickBooks bank transactions against bank statements, allowing users to export beautifully formatted, styled Excel reports (using xlsx-js-style).
7. Business Valuation: Provides dynamic EBITDA multiplier and Discounted Cash Flow (DCF) valuation models based on real-time financial data.

Tone: Professional, helpful, concise, and guiding. Keep explanations brief but informative.

User question: ${message}
`;

    const result = await model.generateContent(prompt);
    const response = result.response.text();

    res.json({ reply: response });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Chatbot error" });
  }
});

module.exports = router;
