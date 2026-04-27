const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../../../.env") });

async function test() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("No API key found in .env at", path.join(__dirname, "../../../../.env"));
    return;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const models = ["gemini-2.5-flash", "gemini-3.1-flash-lite-preview", "gemini-2.0-flash"];

  const pdfPath = "C:\\Users\\adiko\\Downloads\\Example QoE Documents\\Example QoE Documents\\Tax Return\\Tax Return 2.pdf";
  if (!fs.existsSync(pdfPath)) {
    console.error("PDF not found at", pdfPath);
    return;
  }
  const pdfBuffer = fs.readFileSync(pdfPath);

  for (const modelName of models) {
    console.log(`Testing model: ${modelName}`);
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        {
          inlineData: {
            mimeType: "application/pdf",
            data: pdfBuffer.toString("base64"),
          },
        },
        { text: "Extract all financial data from Form 1120-S as JSON (year, totalRevenue, totalCostOfGoodsSold, grossProfit, officerWages, depreciation, amortization, interestExpense, interestIncome, allOtherExpenses, netIncome)." },
      ]);
      console.log(`Result for ${modelName}:`, result.response.text());
      return; 
    } catch (err) {
      console.error(`Error for ${modelName}:`, err.message);
    }
  }
}

test();
