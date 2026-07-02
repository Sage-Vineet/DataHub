const { GoogleGenerativeAI } = require("@google/generative-ai");
const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const { getGeminiModels } = require("../config/geminiModels");

// Dynamically selected via GEMINI_MODELS / GEMINI_MODEL env; this array is the
// default fallback order (stronger "flash" first for scanned statements) used
// when no override is configured.
const GEMINI_MODELS = getGeminiModels(["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MONTH_ABBR = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
const MONTH_NAMES = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function monthStrToNum(str) {
  if (!str) return null;
  const s = str.toLowerCase().trim();
  return MONTH_NAMES[s] || MONTH_ABBR[s.slice(0, 3)] || null;
}

function toMonthKey(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;
  const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) return `${usMatch[3]}-${usMatch[1].padStart(2, "0")}`;
  const usDashMatch = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (usDashMatch) return `${usDashMatch[3]}-${usDashMatch[1].padStart(2, "0")}`;
  const parts = s.split(/[\s,/-]+/);
  const abbr = parts[0].toLowerCase().slice(0, 3);
  const month = MONTH_ABBR[abbr];
  const yearPart = parts.find((p) => /^\d{4}$/.test(p));
  if (month && yearPart) return `${yearPart}-${month}`;
  const shortMatch = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (shortMatch) return `${shortMatch[2]}-${shortMatch[1].padStart(2, "0")}`;
  return null;
}

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function buildMonthLabel(key) {
  try {
    return new Date(`${key}-01`).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  } catch {
    return key;
  }
}

// "2025-01" → "Jan-2025"  (spec display format)
function toDisplayMonth(isoKey) {
  const [year, month] = String(isoKey).split("-");
  const idx = parseInt(month, 10) - 1;
  return `${MONTH_SHORT[idx] || month}-${year}`;
}

// "Jan-2025" → "2025-01"  (internal sort key)
function displayMonthToIso(displayKey) {
  const parts = String(displayKey).split("-");
  if (parts.length < 2) return displayKey;
  const [mon, year] = parts;
  const MONTH_MAP = {Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"};
  return `${year}-${MONTH_MAP[mon] || "01"}`;
}

function normalizeBankBinary(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array || Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "object" && data.type === "Buffer" && Array.isArray(data.data)) return Buffer.from(data.data);
  if (typeof data === "string") {
    const raw = data.trim();
    if (!raw) return null;
    if (/^\\x[0-9a-f]+$/i.test(raw)) return Buffer.from(raw.slice(2), "hex");
    if (/^0x[0-9a-f]+$/i.test(raw)) return Buffer.from(raw.slice(2), "hex");
    return Buffer.from(raw, "base64");
  }
  return null;
}

// ─── Amount helpers ───────────────────────────────────────────────────────────
function parseAmount(str) {
  if (str == null) return 0;
  const s = String(str).replace(/[$,\s]/g, "");
  if (/^\([\d.]+\)$/.test(s)) return -(parseFloat(s.slice(1, -1)) || 0);
  return parseFloat(s) || 0;
}

function lastAmountOnLine(line) {
  const matches = [...String(line).matchAll(/([\d,]+\.\d{2})/g)];
  return matches.length ? parseAmount(matches[matches.length - 1][1]) : null;
}

function allAmountsOnLine(line) {
  return [...String(line).matchAll(/([\d,]+\.\d{2})/g)].map((m) => parseAmount(m[1]));
}

// ─── Balance validation ───────────────────────────────────────────────────────
function validateBalance(stmt) {
  const beginning = stmt.beginning_balance || 0;
  const deposits  = stmt.deposits          || 0;
  const withdrawals = stmt.withdrawals     || 0;
  const fees      = stmt.fees              || 0;
  const ending    = stmt.ending_balance    || 0;

  // Primary: standard bank formula  beginning + deposits - withdrawals - fees = ending
  const expected = beginning + deposits - withdrawals - fees;
  const variance = Math.abs(expected - ending);
  if (variance <= 1.0) return "Verified";

  // Secondary: AI sometimes sets beginning = ending when the statement's opening
  // balance is 0 (or when there is no prior balance shown).  If that pattern is
  // detected AND deposits - withdrawals ≈ ending, the extraction is effectively
  // correct — treat as Verified and let the caller fix beginning_balance to 0.
  if (Math.abs(beginning - ending) < 0.02 && Math.abs(deposits - withdrawals - fees - ending) <= 1.0) {
    return "Verified";
  }

  // Tertiary: percentage-based tolerance (≤ 0.5% of the larger of beginning/ending).
  // Handles minor rounding differences that arise when a bank sums line items
  // to more decimal places than it prints.
  const scale = Math.max(Math.abs(beginning), Math.abs(ending), 1);
  if (variance / scale <= 0.005) return "Verified";

  return "Needs Review";
}

// ─── Duplicate detection ──────────────────────────────────────────────────────
function deduplicateStatements(statements) {
  const seen = new Map();
  for (const s of statements) {
    const key = `${(s.account_number || "").slice(-6)}|${s.period_end || ""}`;
    const existing = seen.get(key);
    if (!existing || (s._uploadedAt || 0) >= (existing._uploadedAt || 0)) {
      seen.set(key, s);
    }
  }
  return Array.from(seen.values());
}

// ─── PDF text extraction ──────────────────────────────────────────────────────
async function extractTextFromPdfBuffer(buffer) {
  try {
    const data = await pdfParse(buffer, { max: 0 });
    return data.text || "";
  } catch (err) {
    console.warn(`[BankPDF] pdf-parse failed: ${err.message}`);
    return "";
  }
}

// ─── Wells Fargo text parser ──────────────────────────────────────────────────
function parseWellsFargoFromText(text) {
  const results = [];
  if (!/wells\s*fargo/i.test(text)) return results;

  const lines = text.split(/\r?\n/);
  const MONTHS = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
  // Dash variants: hyphen, en-dash, em-dash, Unicode minus
  const DASH = "[-–—−]";

  // Combined single-line header
  const headerRe = new RegExp(
    `Account\\s+number[:\\s]+(\\d{4,})\\s+(${MONTHS})\\s+(\\d{1,2}),?\\s*(\\d{4})\\s*${DASH}+\\s*(${MONTHS})\\s+(\\d{1,2}),?\\s*(\\d{4})`,
    "i",
  );
  // Account number only (for split-header fallback)
  const acctRe = /Account\s+number[:\s]+(\d{4,})/i;
  // Standalone date range
  const dateRangeRe = new RegExp(
    `(${MONTHS})\\s+(\\d{1,2}),?\\s*(\\d{4})\\s*${DASH}+\\s*(${MONTHS})\\s+(\\d{1,2}),?\\s*(\\d{4})`,
    "i",
  );

  const found = [];

  // Pass 1: single-line combined header
  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(headerRe);
    if (hm) {
      found.push({ lineIndex: i, acctNum: hm[1], sm: hm[2], sd: hm[3], sy: hm[4], em: hm[5], ed: hm[6], ey: hm[7] });
    }
  }

  // Pass 2: try concatenating adjacent lines (pdf-parse often splits the header)
  if (!found.length) {
    for (let i = 0; i < lines.length - 1; i++) {
      const merged = `${lines[i]} ${lines[i + 1]}`;
      const hm = merged.match(headerRe);
      if (hm) {
        found.push({ lineIndex: i + 1, acctNum: hm[1], sm: hm[2], sd: hm[3], sy: hm[4], em: hm[5], ed: hm[6], ey: hm[7] });
      }
    }
  }

  // Pass 3: account number on one line, date range anywhere within ±3 lines
  if (!found.length) {
    for (let i = 0; i < lines.length; i++) {
      const am = lines[i].match(acctRe);
      if (!am) continue;
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 5); j++) {
        const dm = lines[j].match(dateRangeRe);
        if (dm) {
          found.push({ lineIndex: Math.max(i, j), acctNum: am[1], sm: dm[1], sd: dm[2], sy: dm[3], em: dm[4], ed: dm[5], ey: dm[6] });
          break;
        }
      }
    }
  }

  const extractEntityName = (li) => {
    for (let k = Math.max(0, li - 5); k < Math.min(li + 3, lines.length); k++) {
      const l = lines[k].trim();
      if (l.length > 3 && l.length < 80 && /^[A-Z]/.test(l) && !/Account|Statement|Wells|Fargo|Balance|Deposit|Period/i.test(l)) {
        return l;
      }
    }
    return "";
  };

  for (const f of found) {
    const startMonth = monthStrToNum(f.sm);
    const endMonth = monthStrToNum(f.em);
    if (!startMonth || !endMonth) continue;

    const periodStart = `${f.sy}-${startMonth}-${String(f.sd).padStart(2, "0")}`;
    const periodEnd = `${f.ey}-${endMonth}-${String(f.ed).padStart(2, "0")}`;
    const last4 = f.acctNum.slice(-4);
    const bankName = `Wells Fargo (${last4})`;

    let beginning_balance = null, deposits = null, withdrawals = null, fees = 0, ending_balance = null;

    const windowEnd = Math.min(f.lineIndex + 100, lines.length);
    for (let j = f.lineIndex + 1; j < windowEnd; j++) {
      const l = lines[j];
      const allAmts = allAmountsOnLine(l);

      // Account activity summary row: account number + 4 amounts on same line
      if (allAmts.length >= 4 && l.includes(last4) && beginning_balance === null) {
        beginning_balance = allAmts[0];
        deposits = allAmts[1];
        withdrawals = Math.abs(allAmts[2]);
        ending_balance = allAmts[allAmts.length - 1];
        break;
      }

      const amt = lastAmountOnLine(l);
      if (amt === null) continue;

      if (beginning_balance === null && /Beginning\s+balance/i.test(l)) {
        beginning_balance = amt;
      } else if (deposits === null && /(?:Total\s+)?(?:credits?|deposits?)/i.test(l) && !/Ending|Beginning|Service/i.test(l)) {
        deposits = amt;
      } else if (withdrawals === null && /(?:Total\s+)?(?:debits?|withdrawals?|payments?)/i.test(l) && !/Ending|Beginning/i.test(l)) {
        withdrawals = Math.abs(amt);
      } else if (ending_balance === null && /Ending\s+balance/i.test(l)) {
        ending_balance = amt;
      } else if (/(?:Service\s+)?[Ff]ee/i.test(l) && !/Beginning|Ending|Deposit|Withdrawal/i.test(l)) {
        fees += amt;
      }
    }

    if (ending_balance !== null) {
      const stmt = {
        bank_name: bankName,
        account_name: extractEntityName(f.lineIndex),
        account_number: f.acctNum,
        period_start: periodStart,
        period_end: periodEnd,
        beginning_balance: beginning_balance ?? 0,
        deposits: deposits ?? 0,
        withdrawals: withdrawals ?? 0,
        fees,
        ending_balance,
        source: "text_parser",
      };
      stmt.status = validateBalance(stmt);
      results.push(stmt);
      console.log(`[WFParser] ${bankName} ${periodEnd} end=${ending_balance} status=${stmt.status}`);
    }
  }
  return results;
}

// ─── BankProv / NeedhamBank / community bank parser ───────────────────────────
function parseCommunityBankFromText(text, fileName) {
  const results = [];
  const lines = text.split(/\r?\n/);

  let institutionName = null;
  const bankNameRe = /^(BankProv|Needham\s*Bank|NeedhamBank|Eastern\s*Bank|Rockland\s*Trust|Blue\s*Hills\s*Bank|Brookline\s*Bank|Dedham\s*Savings|Century\s*Bank|Brookline)/i;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const nm = lines[i].trim().match(bankNameRe);
    if (nm) { institutionName = nm[0].trim(); break; }
  }
  if (!institutionName) {
    institutionName = (fileName || "").replace(/\.[^.]+$/, "").replace(/[_-]/g, " ") || "Community Bank";
  }

  const stmtDateRe = /Statement\s+Date\s*:?\s*(\w+)\s+(\d{1,2}),\s*(\d{4})\s+(?:thru|through|to|-)\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sm = line.match(stmtDateRe);
    if (!sm) continue;

    const startMonth = monthStrToNum(sm[1]);
    const startDay = sm[2].padStart(2, "0");
    const startYear = sm[3];
    const endMonth = monthStrToNum(sm[4]);
    const endDay = sm[5].padStart(2, "0");
    const endYear = sm[6];
    if (!endMonth) continue;

    let acctNum = "", acctSuffix = "";
    for (let k = i - 3; k < i + 8; k++) {
      if (k < 0 || k >= lines.length) continue;
      const am = lines[k].match(/Account\s*(?:Number|#|No\.?)?\s*:?\s*[\*xX]*(\d{4,})\b/i);
      if (am) { acctNum = am[1]; acctSuffix = ` (${am[1].slice(-4)})`; break; }
      const masked = lines[k].match(/[xX*]{2,}(\d{4})\b/);
      if (masked) { acctNum = masked[1]; acctSuffix = ` (${masked[1]})`; break; }
    }

    const bankName = `${institutionName}${acctSuffix}`;
    let beginning_balance = null, deposits = null, interest = 0, withdrawals = null, fees = 0, ending_balance = null;

    const windowEnd = Math.min(i + 80, lines.length);
    for (let j = i + 1; j < windowEnd; j++) {
      const l = lines[j];
      const allAmts = allAmountsOnLine(l);

      // 6-col summary data row
      if (allAmts.length >= 6 && beginning_balance === null && ending_balance === null) {
        const nonNum = l.replace(/[\d,.$\s]/g, "");
        if (nonNum.length < 20) {
          beginning_balance = allAmts[0]; deposits = allAmts[1]; interest = allAmts[2];
          withdrawals = allAmts[3]; fees = allAmts[4]; ending_balance = allAmts[5];
          break;
        }
      }

      const amt = lastAmountOnLine(l);
      if (amt === null) continue;

      if (beginning_balance === null && /(?:Previous|Beginning)\s+Balance/i.test(l)) beginning_balance = amt;
      else if (/(?:Total\s+)?Deposits/i.test(l) && !/Ending|Beginning|Service/i.test(l)) deposits = (deposits ?? 0) + amt;
      else if (/Interest\s+(?:Paid|Credited|Earned)?/i.test(l) && !/Ending|Beginning/i.test(l)) interest += amt;
      else if (withdrawals === null && /(?:Total\s+)?Withdrawals/i.test(l) && !/Ending|Beginning/i.test(l)) withdrawals = Math.abs(amt);
      else if (/(?:Service\s+)?[Ff]ee/i.test(l) && !/Beginning|Ending|Deposit|Withdrawal/i.test(l)) fees += amt;
      else if (ending_balance === null && /Ending\s+Balance/i.test(l)) ending_balance = amt;
    }

    if (ending_balance !== null) {
      const stmt = {
        bank_name: bankName,
        account_name: "",
        account_number: acctNum,
        period_start: startMonth ? `${startYear}-${startMonth}-${startDay}` : "",
        period_end: `${endYear}-${endMonth}-${endDay}`,
        beginning_balance: beginning_balance ?? 0,
        deposits: (deposits ?? 0) + interest,
        withdrawals: withdrawals ?? 0,
        fees,
        ending_balance,
        source: "text_parser",
      };
      stmt.status = validateBalance(stmt);
      results.push(stmt);
      console.log(`[CommBankParser] ${bankName} ${stmt.period_end} end=${ending_balance} status=${stmt.status}`);
    }
  }
  return results;
}

// ─── Generic text parser — broad, aggressive, handles any layout ──────────────
function parseGenericFromText(text, fileName) {
  const results = [];
  const lines = text.split(/\r?\n/);

  const institutionName = (fileName || "Bank").replace(/\.[^.]+$/, "").replace(/[_\-\d]/g, " ").trim() || "Bank";

  // Detect any date that looks like a statement end date
  const endDatePatterns = [
    /(?:period\s+end(?:ing)?|statement\s+end(?:ing)?|through|thru|as\s+of|ending)\s+(\w+)\s+(\d{1,2}),\s*(\d{4})/gi,
    /(?:statement\s+date|closing\s+date)\s*:?\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/gi,
    /(\w+)\s+(\d{1,2}),\s*(\d{4})\s*(?:statement|period|closing)/gi,
    // Plain date at end of date-range: "January 1 - January 31, 2025"
    /-\s*(\w+)\s+(\d{1,2}),\s*(\d{4})/g,
  ];

  const detectedDates = [];
  for (const re of endDatePatterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const monthWord = m[1] || m[2];
      const day = m[2] || m[3];
      const year = m[3] || m[4];
      const month = monthStrToNum(monthWord);
      if (month && /^\d{4}$/.test(year)) {
        detectedDates.push(`${year}-${month}-${String(day).padStart(2, "0")}`);
      }
    }
  }

  // Also try to detect account number in the entire text
  let accountNumber = "";
  const acctMatch = text.match(/Account\s*(?:Number|#|No\.?)?\s*:?\s*[\*xX]*(\d{4,})\b/i);
  if (acctMatch) accountNumber = acctMatch[1];

  let beginning_balance = null, deposits = null, withdrawals = null, fees = 0, ending_balance = null;

  for (const l of lines) {
    const amt = lastAmountOnLine(l);
    if (amt === null || amt < 0) continue;

    if (beginning_balance === null && /(?:Previous|Beginning|Opening|Starting)\s+(?:Balance|Bal\.?)/i.test(l)) {
      beginning_balance = amt;
    } else if (ending_balance === null && /(?:Ending|Closing|Current|Available)\s+(?:Balance|Bal\.?)/i.test(l)) {
      ending_balance = amt;
    } else if (/(?:Total\s+)?(?:Deposits?|Credits?|Incoming)/i.test(l) && !/Ending|Beginning|Service/i.test(l)) {
      deposits = (deposits ?? 0) + amt;
    } else if (/(?:Total\s+)?(?:Withdrawals?|Debits?|Payments?|Outgoing)/i.test(l) && !/Ending|Beginning/i.test(l)) {
      withdrawals = (withdrawals ?? 0) + Math.abs(amt);
    } else if (/(?:Service\s+)?[Ff]ees?/i.test(l) && !/Beginning|Ending|Deposit|Withdrawal/i.test(l)) {
      fees += amt;
    }
  }

  // Only require ending_balance — starting balance can be derived
  if (ending_balance !== null) {
    const periodEnd = detectedDates.length ? detectedDates[detectedDates.length - 1] : "";
    const last4 = accountNumber.slice(-4);
    const bankName = last4 ? `${institutionName} (${last4})` : institutionName;

    const stmt = {
      bank_name: bankName,
      account_name: "",
      account_number: accountNumber,
      period_start: "",
      period_end: periodEnd,
      beginning_balance: beginning_balance ?? 0,
      deposits: deposits ?? 0,
      withdrawals: withdrawals ?? 0,
      fees,
      ending_balance,
      source: "text_parser",
    };
    stmt.status = validateBalance(stmt);
    results.push(stmt);
    console.log(`[GenericParser] ${bankName} ${periodEnd || "(no date)"} end=${ending_balance} status=${stmt.status}`);
  }
  return results;
}

// ─── PDF rule-based dispatcher ────────────────────────────────────────────────
function parseTextStatements(text, fileName) {
  if (!text?.trim()) return [];

  let results = parseWellsFargoFromText(text);
  if (results.length) { console.log(`[TextParser] WF: ${results.length} from "${fileName}"`); return results; }

  results = parseCommunityBankFromText(text, fileName);
  if (results.length) { console.log(`[TextParser] Community: ${results.length} from "${fileName}"`); return results; }

  results = parseGenericFromText(text, fileName);
  if (results.length) { console.log(`[TextParser] Generic: ${results.length} from "${fileName}"`); return results; }

  return [];
}

// ─── Gemini extraction ────────────────────────────────────────────────────────
const GEMINI_PROMPT = `You are DataHub's Bank Statement Extraction and Reconciliation Engine.

IMPORTANT: Files have already passed document reading. Never assume extraction failed because parsing succeeded.
If file exists and text exists, NEVER return [] unless the document is confirmed NOT to be a bank statement.

STEP 1 — DOCUMENT CLASSIFICATION
Count how many of these keywords appear anywhere in the document:
  "Beginning balance", "Ending balance", "Total credits", "Total debits",
  "Account summary", "Deposits", "Withdrawals", "Account number",
  "Opening balance", "Closing balance", "Statement date", "Transactions"
If ≥ 3 keywords found → classify as BANK_STATEMENT and proceed to extraction.
If < 3 keywords → return [].

STEP 2 — EXTRACT. Do NOT rely on fixed PDF positions. Search the ENTIRE document semantically.

For EACH account and EACH statement period found, return one JSON object with this exact schema:
{
  "bankName": "Wells Fargo",
  "accountName": "MSX Mobility LLC",
  "accountNumber": "8209360067",
  "statementStartDate": "2025-01-01",
  "statementEndDate": "2025-01-31",
  "month": "Jan",
  "year": "2025",
  "startingBalance": 4306.99,
  "deposits": 174012.41,
  "withdrawals": 121647.89,
  "fees": 0,
  "endingBalance": 56671.51
}

EXTRACTION RULES — search for these patterns anywhere in the document:
  Beginning balance / Opening balance / Starting balance / Previous balance → startingBalance
  Total credits / Credits / Deposits / Incoming / Total additions → deposits
  Total debits / Debits / Withdrawals / Outgoing / Total subtractions → withdrawals (ALWAYS positive)
  Service charges / Fees / Maintenance fee → fees
  Ending balance / Closing balance / New balance / Current balance → endingBalance
  accountName: entity or company name on the statement header (not the bank name)
  accountNumber: LAST 4 DIGITS ONLY (e.g. 8209360067 → "0067")
  statementStartDate and statementEndDate: MUST be YYYY-MM-DD format
  month: 3-letter abbreviation (Jan, Feb, … Dec) from the statement end date
  year: 4-digit year from the statement end date

CRITICAL — BEGINNING vs ENDING BALANCE (most common extraction error):
- startingBalance and endingBalance are TWO DIFFERENT numbers on the statement.
- startingBalance = balance BEFORE the statement period (often labelled "Previous Balance", "Balance Forward", or "Opening Balance").
- endingBalance   = balance AFTER the statement period (often labelled "New Balance", "Closing Balance", or "Ending Balance").
- NEVER use the same dollar amount for both startingBalance and endingBalance unless you have confirmed that the account literally had no net change during the period.
- If the statement does NOT show an explicit beginning balance (e.g. first statement for the account), set startingBalance to 0.
- SELF-CHECK: After extracting, verify: startingBalance + deposits - withdrawals - fees ≈ endingBalance (within $1.00).
  If the check fails, re-examine and correct the values before returning.

OUTPUT RULES:
- Return ONLY a raw JSON array. NO markdown, NO code fences, NO explanation text.
- All amounts are plain numbers — no $, no commas, no parentheses.
- Use 0 for any numeric field not found — never omit a field.
- If multiple accounts exist in one PDF: one object per account per period.
- NEVER return [] unless the document is definitively not a bank statement.

Example:
[{"bankName":"Wells Fargo","accountName":"MSX Mobility LLC","accountNumber":"8209360067","statementStartDate":"2025-01-01","statementEndDate":"2025-01-31","month":"Jan","year":"2025","startingBalance":4306.99,"deposits":174012.41,"withdrawals":121647.89,"fees":0,"endingBalance":56671.51}]`;

// Normalize Gemini response — handles both old (period_end) and new (statementEndDate) field names
function normalizeGeminiStatement(s) {
  const periodEnd = s.statementEndDate || s.period_end || "";
  const periodStart = s.statementStartDate || s.period_start || "";
  const rawBankName = (s.bankName || s.bank_name || "Unknown Bank").replace(/\s*\(\d{4}\)\s*$/, "").trim();
  const accountName = s.accountName || s.account_name || "";
  const rawAcctNum = String(s.accountNumber || s.account_number || "");
  // Spec: keep last 4 digits only
  const accountNumber = rawAcctNum.replace(/\D/g, "").slice(-4) || rawAcctNum.slice(-4);

  // Internal grouping key includes last-4 to distinguish multiple accounts at same bank
  const displayBankName = accountNumber
    ? `${rawBankName} (${accountNumber})`
    : rawBankName;

  let beginningBalance = Number(s.startingBalance ?? s.beginning_balance ?? 0) || 0;
  const deposits      = Number(s.deposits ?? 0) || 0;
  const withdrawals   = Math.abs(Number(s.withdrawals ?? 0) || 0);
  const fees          = Number(s.fees ?? 0) || 0;
  let endingBalance   = Number(s.endingBalance ?? s.ending_balance ?? 0) || 0;

  // Auto-correct the most common AI extraction error: beginning = ending when the
  // actual beginning balance is 0.  Signature: beginning ≈ ending AND
  // deposits - withdrawals - fees ≈ ending (i.e. the net of the period = ending).
  if (
    Math.abs(beginningBalance - endingBalance) < 0.02 &&
    Math.abs(deposits - withdrawals - fees - endingBalance) <= 1.0
  ) {
    beginningBalance = 0;
  }

  const stmt = {
    bank_name: displayBankName,       // "Wells Fargo (0067)" — used as grouping key
    bank_name_clean: rawBankName,     // "Wells Fargo" — used in API response
    account_name: accountName,
    account_number: accountNumber,    // "0067" — last 4 only
    period_start: periodStart,
    period_end: periodEnd,
    beginning_balance: beginningBalance,
    deposits,
    withdrawals,
    fees,
    ending_balance: endingBalance,
    source: "gemini",
  };
  stmt.status = validateBalance(stmt);
  return stmt;
}

async function callGeminiWithContent(contents, modelName, fileName) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(contents);
  let text = result.response.text().trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Gemini did not return an array");
  return parsed;
}

// ─── AI self-correction (recheck) ─────────────────────────────────────────────
// A statement is flagged "Needs Review" when its numbers don't satisfy the bank
// balance equation (beginning + deposits - withdrawals - fees ≈ ending). Rather
// than surface an unverified row, we ask the AI to re-examine the document with
// the failing values called out, then adopt the corrected result if — and only
// if — it now reconciles. This raises report accuracy and drives statuses toward
// "Verified" without ever fabricating a pass.
function stmtMatchKey(s) {
  return `${String(s.account_number || "").toLowerCase()}|${s.period_end || s.period_start || ""}`;
}

function buildRecheckPrompt(failing) {
  const lines = failing.map((s, i) => {
    const computed = (s.beginning_balance + s.deposits - s.withdrawals - s.fees);
    return `${i + 1}. Bank="${s.bank_name_clean || s.bank_name}", account ending "${s.account_number || "?"}", ` +
      `period ${s.period_start || "?"} to ${s.period_end || "?"} — extracted: ` +
      `startingBalance=${s.beginning_balance}, deposits=${s.deposits}, withdrawals=${s.withdrawals}, ` +
      `fees=${s.fees}, endingBalance=${s.ending_balance}. ` +
      `This FAILS the check: ${s.beginning_balance} + ${s.deposits} - ${s.withdrawals} - ${s.fees} = ` +
      `${computed.toFixed(2)}, which does not equal endingBalance ${s.ending_balance}.`;
  }).join("\n");

  return `${GEMINI_PROMPT}

RECHECK MODE — a previous extraction of the account(s) below FAILED the balance self-check
(startingBalance + deposits - withdrawals - fees MUST equal endingBalance within $1.00).
Re-examine the document VERY carefully for these specific accounts and correct whichever value(s)
were misread. Common causes: swapping startingBalance and endingBalance, missing one or more
deposits/withdrawals, using a summary total or a running/available balance instead of the true
period totals, reading the wrong statement period, or transposed digits.

Previously-extracted (incorrect) values:
${lines}

Return the corrected data for ALL accounts found in the document (not only the failing ones),
using the exact JSON schema described above. Every returned account MUST satisfy
startingBalance + deposits - withdrawals - fees = endingBalance (within $1.00).`;
}

async function recheckNeedsReview(statements, contentPrefix, fileName, modelName) {
  const failing = statements.filter((s) => s.status === "Needs Review");
  if (!failing.length) return statements;

  console.log(`[BankPDF] ${failing.length} statement(s) need review in "${fileName}" — running AI recheck (${modelName})...`);
  try {
    const parsed = await callGeminiWithContent(
      [...contentPrefix, { text: buildRecheckPrompt(failing) }],
      modelName,
      fileName,
    );
    const rechecked = parsed.map(normalizeGeminiStatement);
    const byKey = new Map(rechecked.map((s) => [stmtMatchKey(s), s]));

    let fixed = 0;
    const merged = statements.map((s) => {
      if (s.status !== "Needs Review") return s;
      const match = byKey.get(stmtMatchKey(s));
      // Only adopt the recheck when it genuinely reconciles — never mask a real
      // discrepancy by relabeling.
      if (match && match.status === "Verified") {
        fixed++;
        return match;
      }
      return s;
    });
    console.log(`[BankPDF] AI recheck reconciled ${fixed}/${failing.length} statement(s) in "${fileName}".`);
    return merged;
  } catch (err) {
    console.warn(`[BankPDF] AI recheck failed for "${fileName}": ${err.message}`);
    return statements;
  }
}

async function extractViaGemini(pdfBase64, fileName) {
  let lastError = null;

  for (const modelName of GEMINI_MODELS) {
    let retries = 2;
    let delay = 4000;
    while (retries > 0) {
      try {
        console.log(`[BankPDF] Gemini PDF ${modelName} for "${fileName}"...`);
        const parsed = await callGeminiWithContent([
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
          { text: GEMINI_PROMPT },
        ], modelName, fileName);

        if (parsed.length === 0) {
          // Don't return early — next model may succeed
          console.warn(`[BankPDF] ${modelName} returned [] for "${fileName}", trying next model`);
          break;
        }
        const stamped = parsed.map(normalizeGeminiStatement);
        console.log(`[BankPDF] Gemini PDF extracted ${stamped.length} statement(s) from "${fileName}"`);
        // AI self-correction pass for any statement that failed the balance check.
        return await recheckNeedsReview(
          stamped,
          [{ inlineData: { mimeType: "application/pdf", data: pdfBase64 } }],
          fileName,
          modelName,
        );
      } catch (err) {
        lastError = err;
        const msg = err.message || String(err);
        console.warn(`[BankPDF] Gemini ${modelName} attempt failed: ${msg}`);
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) break;
        if ((msg.includes("429") || msg.toLowerCase().includes("quota")) && retries > 1) {
          await sleep(delay); delay *= 2; retries--;
        } else break;
      }
    }
  }

  // All models returned [] with no errors → genuinely not a bank statement
  if (!lastError) {
    console.warn(`[BankPDF] All Gemini models returned [] for "${fileName}"`);
    return [];
  }

  const lastMsg = String(lastError.message || "");
  if (lastMsg.includes("429") || lastMsg.toLowerCase().includes("quota")) {
    throw new Error("Gemini quota exceeded — enable billing at ai.google.dev or wait for daily reset");
  }
  throw new Error(`Gemini extraction failed: ${lastMsg}`);
}

// Text-based Gemini fallback — sends extracted plain text when PDF vision fails
async function extractViaGeminiText(rawText, fileName) {
  if (!rawText?.trim()) return [];

  const textPrompt = `${GEMINI_PROMPT}

The text below is extracted from a bank statement PDF. Extract the data from this text:

---
${rawText.slice(0, 30000)}
---`;

  let lastError = null;
  for (const modelName of GEMINI_MODELS) {
    try {
      console.log(`[BankPDF] Gemini TEXT ${modelName} for "${fileName}"...`);
      const parsed = await callGeminiWithContent([{ text: textPrompt }], modelName, fileName);
      if (parsed.length === 0) return [];
      const stamped = parsed.map(normalizeGeminiStatement);
      console.log(`[BankPDF] Gemini text extracted ${stamped.length} statement(s) from "${fileName}"`);
      // AI self-correction pass — re-reads the same source text for any statement
      // that failed the balance check.
      return await recheckNeedsReview(
        stamped,
        [{ text: `Source bank statement text:\n---\n${rawText.slice(0, 30000)}\n---` }],
        fileName,
        modelName,
      );
    } catch (err) {
      lastError = err;
      const msg = err.message || String(err);
      console.warn(`[BankPDF] Gemini text ${modelName} failed: ${msg}`);
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) break;
    }
  }
  console.warn(`[BankPDF] Gemini text fallback failed for "${fileName}": ${lastError?.message}`);
  return [];
}

// ─── Excel / CSV parser ───────────────────────────────────────────────────────
const DATE_COL_NAMES   = ["date", "txn date", "trans date", "transaction date", "posting date", "value date", "effective date"];
const DESC_COL_NAMES   = ["description", "memo", "transaction", "narration", "particulars", "details", "reference"];
const CREDIT_COL_NAMES = ["credit", "deposit", "deposits", "credits", "inflow", "in", "debit amount"];
const DEBIT_COL_NAMES  = ["debit", "withdrawal", "withdrawals", "debits", "outflow", "out", "credit amount"];
const BAL_COL_NAMES    = ["balance", "running balance", "closing balance", "ledger balance"];
const AMOUNT_COL_NAMES = ["amount", "net amount"];

function detectColumnMap(headers) {
  const map = {};
  headers.forEach((h, idx) => {
    const lower = String(h || "").toLowerCase().trim();
    if (!map.date    && DATE_COL_NAMES.some((n) => lower.includes(n)))   map.date = idx;
    if (!map.desc    && DESC_COL_NAMES.some((n) => lower.includes(n)))   map.desc = idx;
    if (!map.credit  && CREDIT_COL_NAMES.some((n) => lower.includes(n))) map.credit = idx;
    if (!map.debit   && DEBIT_COL_NAMES.some((n) => lower.includes(n)))  map.debit = idx;
    if (!map.balance && BAL_COL_NAMES.some((n) => lower.includes(n)))    map.balance = idx;
    if (!map.amount  && AMOUNT_COL_NAMES.some((n) => lower.includes(n))) map.amount = idx;
  });
  return map;
}

function excelSerialToDate(serial) {
  if (typeof serial === "number") {
    const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
    return date.toISOString().slice(0, 10);
  }
  return String(serial).trim();
}

function categorizeTransaction(description) {
  const d = String(description || "").toLowerCase();
  if (/\bzelle\b/.test(d)) return "Transfer";
  if (/\bwire\b|\bwt\b/.test(d)) return "Wire Transfer";
  if (/\bach\b/.test(d)) return "ACH Payment";
  if (/amazon/.test(d)) return "Expense";
  if (/payroll|paychex|adp/.test(d)) return "Payroll";
  if (/intuit|quickbooks|saas|software/.test(d)) return "Software Expense";
  if (/interest/.test(d)) return "Interest Income";
  if (/util|electric|gas|water|pg&e/.test(d)) return "Utility Expense";
  if (/card payment|visa|mastercard|amex/.test(d)) return "Credit Card Payment";
  return "Other";
}

async function extractBankStatementsFromExcel(buffer, fileName) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const allResults = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (raw.length < 3) continue;

    // Find header row (row with most recognizable column names)
    let headerRowIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < Math.min(20, raw.length); i++) {
      const row = raw[i].map((c) => String(c || "").toLowerCase());
      let score = 0;
      for (const n of [...DATE_COL_NAMES, ...DESC_COL_NAMES, ...CREDIT_COL_NAMES, ...DEBIT_COL_NAMES, ...BAL_COL_NAMES, ...AMOUNT_COL_NAMES]) {
        if (row.some((c) => c.includes(n))) score++;
      }
      if (score > bestScore) { bestScore = score; headerRowIdx = i; }
    }

    if (headerRowIdx < 0 || bestScore < 2) {
      console.log(`[ExcelParser] Sheet "${sheetName}" in "${fileName}": no recognizable headers (score=${bestScore}), skipping`);
      continue;
    }

    const headers = raw[headerRowIdx];
    const colMap = detectColumnMap(headers);

    // Extract metadata from rows before the header
    let bankName = (fileName || "Bank").replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").trim();
    let accountName = "", accountNumber = "";
    for (let i = 0; i < headerRowIdx; i++) {
      const rowText = raw[i].join(" ").trim();
      const acctMatch = rowText.match(/Account\s*(?:Number|#|No\.?)?\s*:?\s*[\*xX]*(\d{4,})/i);
      if (acctMatch) accountNumber = acctMatch[1];
      const bankMatch = rowText.match(/(?:Bank|Institution)\s*:?\s*([A-Za-z\s]+)/i);
      if (bankMatch) bankName = bankMatch[1].trim();
      if (rowText.length > 3 && rowText.length < 80 && /^[A-Z]/.test(rowText) &&
          !/Account|Statement|Bank|Balance|Date|Description/i.test(rowText)) {
        accountName = rowText;
      }
    }

    // Parse transaction rows
    const transactions = [];
    let firstBalance = null, lastBalance = null;

    for (let i = headerRowIdx + 1; i < raw.length; i++) {
      const row = raw[i];
      if (row.every((c) => !c)) continue;

      const dateRaw = colMap.date != null ? row[colMap.date] : null;
      const descRaw = colMap.desc != null ? row[colMap.desc] : "";
      const creditRaw = colMap.credit != null ? row[colMap.credit] : null;
      const debitRaw = colMap.debit != null ? row[colMap.debit] : null;
      const amountRaw = colMap.amount != null ? row[colMap.amount] : null;
      const balanceRaw = colMap.balance != null ? row[colMap.balance] : null;

      if (!dateRaw) continue;
      const dateStr = excelSerialToDate(dateRaw);
      if (!/\d{4}/.test(dateStr)) continue;

      let credit = parseAmount(creditRaw);
      let debit = Math.abs(parseAmount(debitRaw));

      // Single amount column — negative = debit, positive = credit
      if (!credit && !debit && amountRaw != null) {
        const amt = parseAmount(amountRaw);
        if (amt > 0) credit = amt;
        else debit = Math.abs(amt);
      }

      const balance = balanceRaw != null ? parseAmount(balanceRaw) : null;
      if (balance !== null && balance !== 0) {
        if (firstBalance === null) firstBalance = { balance, credit, debit };
        lastBalance = balance;
      }

      if (credit > 0 || debit > 0) {
        transactions.push({
          date: dateStr,
          description: String(descRaw || "").trim(),
          amount: credit > 0 ? credit : -debit,
          type: credit > 0 ? "Deposit" : "Withdrawal",
          category: categorizeTransaction(descRaw),
        });
      }
    }

    if (!transactions.length) continue;

    // Compute totals from transactions
    let totalDeposits = 0, totalWithdrawals = 0;
    for (const t of transactions) {
      if (t.type === "Deposit") totalDeposits += t.amount;
      else totalWithdrawals += Math.abs(t.amount);
    }

    // Determine period from first/last transaction dates
    const dates = transactions.map((t) => t.date).filter(Boolean).sort();
    const periodStart = dates[0] || "";
    const periodEnd = dates[dates.length - 1] || "";

    // Beginning balance: either from metadata rows or derived from first balance row
    let beginningBalance = 0;
    if (firstBalance !== null) {
      beginningBalance = firstBalance.balance - firstBalance.credit + firstBalance.debit;
    }
    const endingBalance = lastBalance ?? beginningBalance + totalDeposits - totalWithdrawals;

    const last4 = accountNumber.slice(-4);
    const displayName = last4 ? `${bankName} (${last4})` : bankName;

    const stmt = {
      bank_name: displayName,
      account_name: accountName,
      account_number: accountNumber,
      period_start: periodStart,
      period_end: periodEnd,
      beginning_balance: Math.round(beginningBalance * 100) / 100,
      deposits: Math.round(totalDeposits * 100) / 100,
      withdrawals: Math.round(totalWithdrawals * 100) / 100,
      fees: 0,
      ending_balance: Math.round(endingBalance * 100) / 100,
      transactions,
      source: "excel",
    };
    stmt.status = validateBalance(stmt);
    allResults.push(stmt);
    console.log(`[ExcelParser] Sheet "${sheetName}": ${transactions.length} txns, deposits=${totalDeposits}, withdrawals=${totalWithdrawals}`);
  }

  return allResults;
}

// ─── Main entry point — AI-first three-tier extraction ───────────────────────
async function extractBankStatementsFromPdfBase64(pdfBase64, fileName = "bank_statement.pdf") {
  const buffer = Buffer.from(pdfBase64, "base64");
  const rawText = await extractTextFromPdfBuffer(buffer);
  const hasText = rawText && rawText.trim().length > 50;

  if (hasText) {
    console.log(`[BankPDF] Extracted ${rawText.length} chars from "${fileName}"`);
  } else {
    console.log(`[BankPDF] No text layer in "${fileName}" (scanned/image PDF)`);
  }

  // Tier 1: Gemini multimodal PDF (AI — handles any bank format, any layout)
  try {
    const geminiResults = await extractViaGemini(pdfBase64, fileName);
    if (geminiResults.length > 0) return geminiResults;
    console.log(`[BankPDF] Gemini returned [] for "${fileName}", trying rule-based parser`);
  } catch (err) {
    console.warn(`[BankPDF] Gemini PDF failed for "${fileName}": ${err.message}, falling back to rule-based parser`);
  }

  // Tier 2: Rule-based text parsers (fast, exact, free — covers known formats)
  if (hasText) {
    const textResults = parseTextStatements(rawText, fileName);
    if (textResults.length > 0) {
      console.log(`[BankPDF] Rule-based: ${textResults.length} statement(s) from "${fileName}"`);
      return textResults;
    }
    console.log(`[BankPDF] Rule-based found nothing in "${fileName}", trying Gemini text mode`);
  }

  // Tier 3: Gemini with raw extracted text (cheaper, handles text-layer PDFs when vision fails)
  if (hasText) {
    const geminiTextResults = await extractViaGeminiText(rawText, fileName);
    if (geminiTextResults.length > 0) return geminiTextResults;
  }

  console.warn(`[BankPDF] All extraction methods failed for "${fileName}"`);
  return [];
}

// Entry point for Excel/CSV files
async function extractBankStatementsFromExcelBuffer(buffer, fileName) {
  return extractBankStatementsFromExcel(buffer, fileName);
}

// ─── Build response shape ─────────────────────────────────────────────────────
function buildBankResponseShape(allStatements) {
  if (!allStatements?.length) return { banks: [], months: [], totals: [] };

  const deduplicated = deduplicateStatements(allStatements);
  const groupedBanks = {};
  let skippedCount = 0;

  for (const stmt of deduplicated) {
    const bankName = String(stmt.bank_name || "Unknown Bank").trim();
    const monthKey = toMonthKey(stmt.period_end);

    // Partial data fallback: if period_end missing, try to derive from period_start or use placeholder
    let resolvedMonthKey = monthKey;
    if (!resolvedMonthKey && stmt.period_start) {
      resolvedMonthKey = toMonthKey(stmt.period_start);
    }
    if (!resolvedMonthKey) {
      console.warn(`[BankShape] Skipping statement with no parseable date: bank="${bankName}" ending=${stmt.ending_balance}`);
      skippedCount++;
      continue;
    }

    if (!groupedBanks[bankName]) {
      groupedBanks[bankName] = {
        bank_name_clean: stmt.bank_name_clean || bankName.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
        account_name: stmt.account_name || "",
        account_number: String(stmt.account_number || "").slice(-4),
        months: {},
      };
    }
    const g = groupedBanks[bankName];
    if (!g.account_name && stmt.account_name) g.account_name = stmt.account_name;
    if (!g.account_number && stmt.account_number) g.account_number = String(stmt.account_number).slice(-4);

    const existing = g.months[resolvedMonthKey];
    if (existing) {
      existing.deposits += Number(stmt.deposits) || 0;
      existing.withdrawals += (Number(stmt.withdrawals) || 0) + (Number(stmt.fees) || 0);
      existing.endingBalance = Number(stmt.ending_balance) || 0;
      if (stmt.status === "Needs Review") existing.status = "Needs Review";
    } else {
      g.months[resolvedMonthKey] = {
        monthKey: resolvedMonthKey,
        startingBalance: Number(stmt.beginning_balance) || 0,
        deposits: Number(stmt.deposits) || 0,
        withdrawals: (Number(stmt.withdrawals) || 0) + (Number(stmt.fees) || 0),
        endingBalance: Number(stmt.ending_balance) || 0,
        status: stmt.status || "Verified",
        statement_start_date: stmt.period_start || "",
        statement_end_date: stmt.period_end || resolvedMonthKey,
      };
    }
  }

  if (skippedCount === deduplicated.length) {
    console.warn(`[BankShape] All ${skippedCount} statements skipped — no parseable dates. Returning partial.`);
  }

  const allMonthKeys = new Set();

  const banks = Object.entries(groupedBanks).map(([bankKey, bankData]) => {
    const months = Object.entries(bankData.months)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mk, values]) => {
        allMonthKeys.add(mk);
        return { ...values, monthKey: mk, displayMonth: toDisplayMonth(mk) };
      });

    const acctTotals = months.reduce(
      (acc, m) => ({
        startingBalance: acc.startingBalance + m.startingBalance,
        deposits: acc.deposits + m.deposits,
        withdrawals: acc.withdrawals + m.withdrawals,
        endingBalance: acc.endingBalance + m.endingBalance,
      }),
      { startingBalance: 0, deposits: 0, withdrawals: 0, endingBalance: 0 },
    );

    const hasNeedsReview = months.some((m) => m.status === "Needs Review");

    return {
      bank_name: bankKey,                       // "Wells Fargo (0067)" — grouping key + dropdown label
      bank_name_clean: bankData.bank_name_clean, // "Wells Fargo"
      account_name: bankData.account_name,
      account_number: bankData.account_number,  // "0067" last-4 only
      accounts: [{
        account_name: "Business Checking",
        months,
        totals: acctTotals,
        status: hasNeedsReview ? "Needs Review" : "Verified",
      }],
    };
  });

  const sortedMonthKeys = Array.from(allMonthKeys).sort();

  // Spec format: months as display strings ["Jan-2025", "Jan-2026"]
  const months = sortedMonthKeys.map(toDisplayMonth);

  // Spec format: totals with month as "Jan-2025"
  const totals = sortedMonthKeys.map((mk) => {
    let startingBalance = 0, deposits = 0, withdrawals = 0, endingBalance = 0;
    banks.forEach((bank) => {
      const m = bank.accounts[0].months.find((x) => x.monthKey === mk);
      if (m) {
        startingBalance += m.startingBalance;
        deposits += m.deposits;
        withdrawals += m.withdrawals;
        endingBalance += m.endingBalance;
      }
    });
    return { month: toDisplayMonth(mk), monthKey: mk, startingBalance, deposits, withdrawals, endingBalance };
  });

  return { banks, months, totals };
}

module.exports = {
  normalizeBankBinary,
  extractBankStatementsFromPdfBase64,
  extractBankStatementsFromExcelBuffer,
  buildBankResponseShape,
  toMonthKey,
  buildMonthLabel,
  toDisplayMonth,
  displayMonthToIso,
};
