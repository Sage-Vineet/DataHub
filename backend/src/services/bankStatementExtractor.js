const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MONTH_ABBR = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function toMonthKey(dateStr) {
  if (!dateStr) return null;
  const isoMatch = String(dateStr).match(/^(\d{4})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;
  const parts = String(dateStr).trim().split(/[\s,/-]+/);
  const abbr = parts[0].toLowerCase().slice(0, 3);
  const month = MONTH_ABBR[abbr];
  const yearPart = parts.find((p) => /^\d{4}$/.test(p));
  if (month && yearPart) return `${yearPart}-${month}`;
  return null;
}

function buildMonthLabel(key) {
  try {
    return new Date(`${key}-01`).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  } catch {
    return key;
  }
}

function normalizeBankBinary(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array || Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) {
    return Buffer.from(data.data);
  }
  if (typeof data === "string") {
    const raw = data.trim();
    if (!raw) return null;
    if (/^\\x[0-9a-f]+$/i.test(raw)) return Buffer.from(raw.slice(2), "hex");
    if (/^0x[0-9a-f]+$/i.test(raw)) return Buffer.from(raw.slice(2), "hex");
    return Buffer.from(raw, "base64");
  }
  return null;
}

async function extractBankStatementsFromPdfBase64(pdfBase64, fileName = "bank_statement.pdf") {
  const prompt = `You are reading a bank statement PDF. Your job is to extract every monthly Account Summary (or Statement Summary) found in this document, for EVERY bank account present.

For each statement period you find, return:
- bank_name: the name of the bank (e.g. "Needham Bank", "BankProv"). If an account number is visible, append the last 4 digits in parentheses e.g. "Needham Bank (1234)".
- period_end: the END date of the statement period in YYYY-MM-DD format (use this to determine which month this belongs to).
- beginning_balance: the opening/beginning balance as a number (no commas, no $).
- deposits: total deposits/credits as a number.
- withdrawals: total withdrawals/debits as a number (positive number even if the PDF shows it as a debit).
- fees: total fees as a number (0 if not shown separately).
- ending_balance: the closing/ending balance as a number.

Rules:
- Include ALL statement periods from ALL banks in the document.
- If a statement spans two months (e.g. Nov 29 thru Dec 31), use the end month (December) as the period month.
- Return ONLY a raw JSON array. No markdown fences, no explanation.
- All numeric values must be plain numbers (floats allowed). Use 0 for blank/missing fields.

Example output:
[
  {"bank_name":"Needham Bank (1234)","period_end":"2025-12-31","beginning_balance":0,"deposits":305491.72,"withdrawals":305481.72,"fees":10.00,"ending_balance":0},
  {"bank_name":"BankProv (5678)","period_end":"2025-11-14","beginning_balance":0,"deposits":102674.52,"withdrawals":102664.52,"fees":10.00,"ending_balance":0}
]`;

  let lastError = null;
  for (const modelName of GEMINI_MODELS) {
    let retries = 2;
    let delay = 4000;
    while (retries > 0) {
      try {
        console.log(`[BankPDF] Trying Gemini model ${modelName} for "${fileName}"...`);
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: modelName });

        const result = await model.generateContent([
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
          { text: prompt },
        ]);

        let text = result.response.text().trim();
        text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error("Gemini did not return an array");
        console.log(`[BankPDF] Gemini extracted ${parsed.length} statement(s) from "${fileName}"`);
        return parsed;
      } catch (err) {
        lastError = err;
        const msg = err.message || String(err);
        console.warn(`[BankPDF] Gemini ${modelName} failed: ${msg}`);
        const isNotFound = msg.includes("404") || msg.toLowerCase().includes("not found");
        const isQuota = msg.includes("429") || msg.toLowerCase().includes("quota");
        if (isNotFound) break;
        if (isQuota && retries > 1) {
          await sleep(delay);
          delay *= 2;
          retries--;
        } else {
          break;
        }
      }
    }
  }
  const lastMsg = String(lastError?.message || "");
  if (lastMsg.includes("429") || lastMsg.toLowerCase().includes("quota")) {
    throw new Error("Gemini API quota exceeded — enable billing at ai.google.dev or wait for daily reset");
  }
  throw new Error(`Gemini extraction failed: ${lastMsg || "unknown error"}`);
}

function buildBankResponseShape(allStatements) {
  const groupedBanks = {};

  for (const stmt of allStatements) {
    const bankName = String(stmt.bank_name || "Unknown Bank").trim();
    const monthKey = toMonthKey(stmt.period_end);
    if (!monthKey) continue;

    if (!groupedBanks[bankName]) groupedBanks[bankName] = {};

    const existing = groupedBanks[bankName][monthKey];
    if (existing) {
      existing.deposits += Number(stmt.deposits) || 0;
      existing.withdrawals += (Number(stmt.withdrawals) || 0) + (Number(stmt.fees) || 0);
      existing.endingBalance = Number(stmt.ending_balance) || 0;
    } else {
      groupedBanks[bankName][monthKey] = {
        startingBalance: Number(stmt.beginning_balance) || 0,
        deposits: Number(stmt.deposits) || 0,
        withdrawals: (Number(stmt.withdrawals) || 0) + (Number(stmt.fees) || 0),
        endingBalance: Number(stmt.ending_balance) || 0,
      };
    }
  }

  const allMonths = new Set();

  const banks = Object.entries(groupedBanks).map(([bankName, monthData]) => {
    const months = Object.entries(monthData)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monthKey, values]) => {
        allMonths.add(monthKey);
        return { monthKey, ...values };
      });

    const totals = months.reduce(
      (acc, m) => ({
        startingBalance: acc.startingBalance + m.startingBalance,
        deposits: acc.deposits + m.deposits,
        withdrawals: acc.withdrawals + m.withdrawals,
        endingBalance: acc.endingBalance + m.endingBalance,
      }),
      { startingBalance: 0, deposits: 0, withdrawals: 0, endingBalance: 0 },
    );

    return { bank_name: bankName, accounts: [{ account_name: "Business Checking", months, totals }] };
  });

  const sortedMonths = Array.from(allMonths).sort();
  const months = sortedMonths.map((key) => ({ key, label: buildMonthLabel(key) }));
  const totals = sortedMonths.map((monthKey) => {
    let startingBalance = 0, deposits = 0, withdrawals = 0, endingBalance = 0;
    banks.forEach((bank) => {
      const m = bank.accounts[0].months.find((x) => x.monthKey === monthKey);
      if (m) {
        startingBalance += m.startingBalance;
        deposits += m.deposits;
        withdrawals += m.withdrawals;
        endingBalance += m.endingBalance;
      }
    });
    return { monthKey, startingBalance, deposits, withdrawals, endingBalance };
  });

  return { banks, months, totals };
}

module.exports = {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  buildBankResponseShape,
  toMonthKey,
  buildMonthLabel,
};
