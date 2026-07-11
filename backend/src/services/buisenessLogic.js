// ============================================================================
// Business logic helpers — General Ledger vs Balance Sheet reconciliation
// ============================================================================

const { supabase } = require("../db");

const TABLE_COA = "chart_of_accounts";

/**
 * Normalize an account name/number for comparison (string, trimmed, lower-cased).
 * @param {*} value
 * @returns {string}
 */
function normalizeName(value) {
    return String(value ?? "").trim().toLowerCase();
}

/**
 * Pull a comparable account number out of a balance sheet record. The record
 * may be a plain string/number or an object carrying an account_number /
 * accountNumber field.
 * @param {*} record
 * @returns {string}
 */
function bsRecordAccountNumber(record) {
    if (record && typeof record === "object") {
        return normalizeName(record.account_number ?? record.accountNumber);
    }
    return normalizeName(record);
}

/**
 * Split a list of account records into those whose (normalized) name exists in
 * the Chart of Accounts and those that do not. For matches, the actual COA
 * account_name is captured so the source name and the COA name can be shown
 * side by side.
 * @param {Array<*>} records
 * @param {Map<string, string>} coaNameMap  normalized name -> COA account_name
 * @returns {{ matched: Array<{sourceName: *, coaName: string}>, unmatched: Array<*> }}
 */
function splitByCoaMatch(records, coaNameMap) {
    const matched = [];
    const unmatched = [];
    for (const record of records) {
        const coaName = coaNameMap.get(normalizeName(record));
        if (coaName !== undefined) {
            matched.push({ sourceName: record, coaName });
        } else {
            unmatched.push(record);
        }
    }
    return { matched, unmatched };
}

/**
 * Print matched records as clearly labeled pairs so it is obvious which name
 * comes from the source table (Balance Sheet / P&L) and which comes from the
 * COA table.
 * @param {string} sourceLabel  e.g. "Balance Sheet" or "P&L"
 * @param {Array<{sourceName: *, coaName: string}>} matched
 */
function printMatchedPairs(sourceLabel, matched) {
    console.log(`\n${sourceLabel} accounts matched in COA (${matched.length}):`);
    console.log(`   ${"NAME FROM " + sourceLabel.toUpperCase()}`.padEnd(55) + "| NAME FROM COA TABLE");
    console.log("   " + "-".repeat(52) + "|" + "-".repeat(40));
    for (const { sourceName, coaName } of matched) {
        console.log("   " + String(sourceName).padEnd(52) + "| " + coaName);
    }
}

/**
 * Print records that had no COA match.
 * @param {string} sourceLabel
 * @param {Array<*>} unmatched
 */
function printUnmatched(sourceLabel, unmatched) {
    console.log(`\n${sourceLabel} accounts NOT found in COA (${unmatched.length}):`);
    for (const name of unmatched) {
        console.log("   " + String(name) + "   ->   (no matching COA record)");
    }
}

/**
 * Compare every unique GL account against every unique balance sheet record,
 * split the GL accounts into balance-sheet vs P&L buckets, then check each
 * bucket against the Chart of Accounts to see which records have a matching
 * COA row and which do not. All lists are printed to the console, with matches
 * shown as source-name vs COA-name pairs.
 *
 * @param {Array<*>} glAccountNumbers      Unique account numbers/names from the GL.
 * @param {Array<*>} balanceSheetRecords   Unique balance sheet records.
 * @returns {Promise<{
 *   bsRecords: Array<*>, pnlRecords: Array<*>,
 *   bsMatched: Array<{sourceName: *, coaName: string}>, bsUnmatched: Array<*>,
 *   pnlMatched: Array<{sourceName: *, coaName: string}>, pnlUnmatched: Array<*>,
 * }>}
 */
async function compareGlWithBalanceSheet(glAccountNumbers, balanceSheetRecords) {
    const glList = Array.isArray(glAccountNumbers) ? glAccountNumbers : [];
    const bsList = Array.isArray(balanceSheetRecords) ? balanceSheetRecords : [];

    // Build a lookup of every balance sheet account number for O(1) membership tests.
    const bsAccountNumbers = new Set(bsList.map(bsRecordAccountNumber));

    const bsRecords = [];
    const pnlRecords = [];

    // GL accounts that exist in the balance sheet are treated as BS accounts;
    // the rest are treated as P&L accounts.
    for (const glAccount of glList) {
        if (bsAccountNumbers.has(normalizeName(glAccount))) {
            bsRecords.push(glAccount);
        } else {
            pnlRecords.push(glAccount);
        }
    }

    // Load every Chart of Accounts name once, keeping the ORIGINAL COA name
    // keyed by its normalized form (one query instead of one per record).
    const { data: coaRows, error } = await supabase
        .from(TABLE_COA)
        .select("account_name");

    if (error) {
        console.error("Failed to load chart_of_accounts:", error.message);
        return { bsRecords, pnlRecords, bsMatched: [], bsUnmatched: [], pnlMatched: [], pnlUnmatched: [] };
    }

    const coaNameMap = new Map();
    for (const r of coaRows || []) {
        const key = normalizeName(r.account_name);
        if (key && !coaNameMap.has(key)) coaNameMap.set(key, r.account_name);
    }

    // Which BS / P&L records have a matching COA row, and which do not.
    const { matched: bsMatched, unmatched: bsUnmatched } = splitByCoaMatch(bsRecords, coaNameMap);
    const { matched: pnlMatched, unmatched: pnlUnmatched } = splitByCoaMatch(pnlRecords, coaNameMap);

    console.log("=== GL split into Balance Sheet vs P&L ===");
    console.log(`BS accounts (${bsRecords.length}):`, bsRecords);
    console.log(`P&L accounts (${pnlRecords.length}):`, pnlRecords);

    console.log("\n=== Matched against Chart of Accounts (source name vs COA name) ===");
    printMatchedPairs("Balance Sheet", bsMatched);
    printUnmatched("Balance Sheet", bsUnmatched);
    printMatchedPairs("P&L", pnlMatched);
    printUnmatched("P&L", pnlUnmatched);

    return { bsRecords, pnlRecords, bsMatched, bsUnmatched, pnlMatched, pnlUnmatched };
}

/**
 * Compare two account-name lists (case-insensitive) and print which records are
 * present in both and which are missing from either side.
 *
 * @param {string}   labelA   name of the first source (e.g. "COA (Balance Sheet)")
 * @param {Array<*>} listA    account names from the first source
 * @param {string}   labelB   name of the second source (e.g. "Balance Sheet")
 * @param {Array<*>} listB    account names from the second source
 * @returns {{
 *   inBoth: Array<{a: *, b: *}>,
 *   onlyInA: Array<*>,
 *   onlyInB: Array<*>,
 * }}
 */
function compareAccountSets(labelA, listA, labelB, listB) {
    // normalized name -> original name, for each side.
    const mapA = new Map();
    for (const n of listA || []) {
        const k = normalizeName(n);
        if (k && !mapA.has(k)) mapA.set(k, n);
    }
    const mapB = new Map();
    for (const n of listB || []) {
        const k = normalizeName(n);
        if (k && !mapB.has(k)) mapB.set(k, n);
    }

    const inBoth = [];
    const onlyInA = [];
    const onlyInB = [];

    for (const [k, orig] of mapA) {
        if (mapB.has(k)) inBoth.push({ a: orig, b: mapB.get(k) });
        else onlyInA.push(orig);
    }
    for (const [k, orig] of mapB) {
        if (!mapA.has(k)) onlyInB.push(orig);
    }

    console.log(`\n======================= ${labelA}  vs  ${labelB} =======================`);

    console.log(`\nPresent in BOTH (${inBoth.length}):`);
    for (const p of inBoth) console.log(`   [OK]      ${p.b}`);

    console.log(`\nIn ${labelB} but MISSING from ${labelA} (${onlyInB.length}):`);
    for (const n of onlyInB) console.log(`   [MISSING] ${n}`);

    console.log(`\nIn ${labelA} but MISSING from ${labelB} (${onlyInA.length}):`);
    for (const n of onlyInA) console.log(`   [MISSING] ${n}`);

    return { inBoth, onlyInA, onlyInB };
}

/**
 * Print a side-by-side comparison of two account-name lists in the format:
 *
 *   <left account>                         | <right account>
 *
 * Rows are grouped: matched pairs first, then rows only on the left (right cell
 * blank / "-- missing --"), then rows only on the right (left cell blank).
 *
 * @param {string}   leftLabel   e.g. "BALANCE SHEET ACCOUNT"
 * @param {Array<*>} leftList    account names for the left column
 * @param {string}   rightLabel  e.g. "COA ACCOUNT"
 * @param {Array<*>} rightList   account names for the right column
 * @param {number}   [colWidth]  left column width
 * @returns {{ inBoth: Array<{left: *, right: *}>, onlyLeft: Array<*>, onlyRight: Array<*> }}
 */
function compareSideBySide(leftLabel, leftList, rightLabel, rightList, colWidth = 45) {
    const mapLeft = new Map();
    for (const n of leftList || []) {
        const k = normalizeName(n);
        if (k && !mapLeft.has(k)) mapLeft.set(k, n);
    }
    const mapRight = new Map();
    for (const n of rightList || []) {
        const k = normalizeName(n);
        if (k && !mapRight.has(k)) mapRight.set(k, n);
    }

    const inBoth = [];
    const onlyLeft = [];
    const onlyRight = [];
    for (const [k, orig] of mapLeft) {
        if (mapRight.has(k)) inBoth.push({ left: orig, right: mapRight.get(k) });
        else onlyLeft.push(orig);
    }
    for (const [k, orig] of mapRight) {
        if (!mapLeft.has(k)) onlyRight.push(orig);
    }

    const pad = (s) => String(s ?? "").padEnd(colWidth);
    const line = () => "-".repeat(colWidth) + "-+-" + "-".repeat(colWidth);

    console.log(`\n${pad(leftLabel)} | ${rightLabel}`);
    console.log(line());

    // Matched rows.
    for (const p of inBoth) console.log(`${pad(p.left)} | ${p.right}`);
    // In left (Balance Sheet) but not in right (COA).
    for (const n of onlyLeft) console.log(`${pad(n)} | -- missing in ${rightLabel} --`);
    // In right (COA) but not in left (Balance Sheet).
    for (const n of onlyRight) console.log(`${pad("-- missing in " + leftLabel + " --")} | ${n}`);

    console.log(line());
    console.log(
        `matched: ${inBoth.length}   ` +
        `only in ${leftLabel}: ${onlyLeft.length}   ` +
        `only in ${rightLabel}: ${onlyRight.length}`,
    );

    return { inBoth, onlyLeft, onlyRight };
}

module.exports = {
    compareGlWithBalanceSheet,
    compareAccountSets,
    compareSideBySide,
};
