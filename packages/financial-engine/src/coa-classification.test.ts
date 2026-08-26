import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  allowedAccountTypesFor,
  buildGlEvidence,
  describeGlEvidence,
  type LedgerRow,
} from "./coa-evidence.js";
import {
  allowedAccountTypes,
  checkClassification,
  statementForAccountType,
} from "./coa-constraints.js";
import { inferTypeFromAccountNumberBlock } from "./coa-hierarchy-evidence.js";

/**
 * Regression tests for four reported misclassifications:
 * Equity → P&L, Expense → Balance Sheet, Income → Liability, Liability →
 * Expense.
 *
 * Ported from `coaClassificationPriority.test.js` on the `data_room` branch.
 * The root causes they lock down, all verified in the original source before
 * the fix:
 *
 * 1. The classifier was working from the ACCOUNT NAME AND NOTHING ELSE. An
 *    account reaches the model only when the uploaded chart and both uploaded
 *    statements failed to resolve it, so its section evidence is null by
 *    construction and the prompt line carried just the name. No ledger evidence
 *    was ever sent.
 *
 * 2. An override confidence floor of 0.95 let a confident model answer BLOCK
 *    the document's own section evidence from correcting it — an inversion of
 *    the stated priority order, triggered precisely when the model was most
 *    overconfident, since it self-scores and the prompt tells it ≥0.90 means
 *    "unambiguous".
 *
 * 3. `statementType` was assignable independently of `accountType`, so
 *    `equity` + `profit_loss` was reachable and the prefix resolver filed an
 *    equity account under the P&L anchor. That is "Equity → P&L" WITH NO AI
 *    MISTAKE AT ALL.
 *
 * 4. Nothing validated the model's account TYPE. The one existing check
 *    compared the model's hierarchy against the model's OWN type — internal
 *    consistency, not correctness — so "Retained Earnings → expense" with
 *    expense-shaped levels passed cleanly.
 *
 * The evidence the fix rests on, measured against live data (10,470 ledger
 * rows, 81 accounts) BEFORE the code was written:
 *
 * - non-zero opening balance → 20/20 accounts are balance-sheet types, 0 are
 *   P&L types. Enforced as a hard rule.
 * - year-over-year continuity → 34/37 correct (92%), and all three errors
 *   predicted "permanent" for an operating expense, i.e. they would have
 *   VETOED the correct answer. Not enforced; prompt hint only.
 * - debit/credit columns → non-zero on 10 of 10,470 rows, and the signed
 *   `amount` uses natural-balance convention. Normal balance is not derivable
 *   here and is not used.
 *
 * Six tests from the original are deliberately NOT ported: they scan the
 * 6,800-line legacy `chartOfAccountsService.js` and `geminiCoaClassifier.js`
 * for wiring that has no equivalent in this package. The two source-scanning
 * tests that guard THIS module's own invariants are ported, retargeted at the
 * ported files.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const sourceOf = (file: string): string => {
  const src = readFileSync(join(HERE, file), "utf8");
  // Strip comments: the prose deliberately discusses the things the code must
  // not do, so scanning raw text would match its own explanation.
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
};

/** Ledger rows shaped exactly as `general_ledger_entries` rows arrive. */
const opening = (name: string, year: number, running: number): LedgerRow => ({
  account_name: name,
  row_type: "BEGINNING_BALANCE",
  running_balance: running,
  transaction_date: `${year}-01-01`,
});
const txn = (name: string, year: number, running: number | null = null): LedgerRow => ({
  account_name: name,
  row_type: "TRANSACTION",
  running_balance: running,
  transaction_date: `${year}-06-15`,
});

describe("GL evidence proves permanence, and never over-claims", () => {
  it("a non-zero opening balance proves a Balance Sheet account", () => {
    const ev = buildGlEvidence([
      opening("Retained Earnings", 2025, -48200.55),
      txn("Retained Earnings", 2025),
    ]).get("retained earnings")!;

    expect(ev.permanence).toBe("permanent");
    expect(allowedAccountTypesFor(ev)).toEqual(["asset", "liability", "equity"]);
  });

  it("NO opening balance asserts nothing at all — absence is not evidence", () => {
    // A permanent account can legitimately lack an opener: first period ever,
    // an ERP that omits zero-balance openers, a partial export. Asserting
    // "temporal" from absence would veto correct classifications.
    const ev = buildGlEvidence([txn("Interest Expense", 2025)]).get("interest expense")!;

    expect(ev.permanence).toBeNull();
    expect(allowedAccountTypesFor(ev)).toBeNull();
  });

  it("a ZERO opening balance is not treated as proof of permanence", () => {
    const ev = buildGlEvidence([
      {
        account_name: "Payroll Tax",
        row_type: "BEGINNING_BALANCE",
        running_balance: 0,
        transaction_date: "2025-01-01",
      },
      txn("Payroll Tax", 2025),
    ]).get("payroll tax")!;

    expect(ev.permanence).toBeNull();
  });

  it("continuity is computed but is NEVER a constraint (measured 92%, mis-vetoes)", () => {
    const ev = buildGlEvidence([
      txn("Charges", 2024, 100),
      txn("Charges", 2024, 150),
      txn("Charges", 2025, 155),
      txn("Charges", 2025, 195),
    ]).get("charges")!;

    expect(typeof ev.carriesAcrossYears).toBe("boolean"); // still exposed for the prompt
    expect(ev.permanence).toBeNull(); // but must not become a permanence claim
    expect(allowedAccountTypesFor(ev)).toBeNull(); // and must not constrain anything
  });

  it("derives no normal-balance / debit-credit signal anywhere", () => {
    // The signed amount uses natural-balance convention, so sign carries no
    // debit/credit meaning. A rule built on it would be wrong on every revenue
    // account — so the module must not reach for those columns at all.
    const code = sourceOf("coa-evidence.ts");
    expect(/normalBalance|debit_amount|credit_amount/.test(code)).toBe(false);
  });

  it("ignores rows that carry no evidence", () => {
    const ev = buildGlEvidence([
      { account_name: "X", row_type: "TOTAL_ROW", running_balance: 999, transaction_date: "2025-01-01" },
      { account_name: "X", row_type: "ACCOUNT_HEADER", transaction_date: "2025-01-01" },
    ]).get("x")!;

    expect(ev.transactionCount).toBe(0);
  });

  it("treats a missing row_type as a transaction, as the trial balance does", () => {
    const ev = buildGlEvidence([
      { account_name: "X", running_balance: 10, transaction_date: "2025-06-15" },
    ]).get("x")!;

    expect(ev.transactionCount).toBe(1);
  });

  it("skips rows with no account name at all", () => {
    expect(buildGlEvidence([{ running_balance: 5, transaction_date: "2025-01-01" }]).size).toBe(0);
  });

  it("falls back to account_section when account_name is absent", () => {
    const ev = buildGlEvidence([
      { account_section: "Accounts Payable", row_type: "BEGINNING_BALANCE", running_balance: 900, transaction_date: "2025-01-01" },
    ]).get("accounts payable")!;

    expect(ev.permanence).toBe("permanent");
  });

  it("ignores an undated row when computing the years present", () => {
    const ev = buildGlEvidence([
      { account_name: "X", row_type: "TRANSACTION", running_balance: 1, transaction_date: null },
      txn("X", 2025, 5),
    ]).get("x")!;

    expect(ev.yearsPresent).toEqual([2025]);
    expect(ev.transactionCount).toBe(2);
  });

  it("accepts a null or undefined row list", () => {
    expect(buildGlEvidence(null).size).toBe(0);
    expect(buildGlEvidence(undefined).size).toBe(0);
  });
});

describe("describeGlEvidence renders the evidence for a prompt or a rejection log", () => {
  // This string is not decoration: it is interpolated into the classifier
  // prompt and quoted back in the veto's `detail`, so it is the whole
  // explanation a reviewer sees for why an answer was refused.

  it("states the proof, and the years it rests on", () => {
    const ev = buildGlEvidence([
      opening("X", 2024, 500),
      opening("X", 2025, 700),
      txn("X", 2025, 10),
    ]).get("x")!;

    const text = describeGlEvidence(ev);
    expect(text).toContain("2024, 2025");
    expect(text).toContain("proves a permanent/Balance Sheet account");
    expect(text).toContain("1 GL transactions");
  });

  it("marks a carrying balance as a WEAK hint, never as proof", () => {
    const ev = buildGlEvidence([
      txn("X", 2024, 100),
      txn("X", 2024, 150),
      txn("X", 2025, 155),
    ]).get("x")!;

    expect(ev.carriesAcrossYears).toBe(true);
    const text = describeGlEvidence(ev);
    expect(text).toContain("weak hint");
    // The wording must not imply proof — the signal mis-vetoes 3 times in 37.
    expect(text).not.toContain("proves");
  });

  it("marks a resetting balance as a weak hint the other way", () => {
    const ev = buildGlEvidence([
      txn("X", 2024, 8000),
      txn("X", 2025, 12),
    ]).get("x")!;

    expect(ev.carriesAcrossYears).toBe(false);
    expect(describeGlEvidence(ev)).toContain("possibly temporal/P&L");
  });

  it("says nothing when there is nothing worth saying", () => {
    expect(describeGlEvidence(null)).toBe("");
    expect(describeGlEvidence(undefined)).toBe("");
    const silent = buildGlEvidence([
      { account_name: "X", row_type: "TOTAL_ROW", transaction_date: "2025-01-01" },
    ]).get("x")!;
    expect(describeGlEvidence(silent)).toBe("");
  });
});

describe("the four reported misclassifications are now rejected", () => {
  const permanentEv = buildGlEvidence([opening("X", 2025, 5000), txn("X", 2025)]).get("x")!;

  it("Equity → P&L is impossible: statement side is derived from type", () => {
    expect(statementForAccountType("equity")).toBe("balance_sheet");

    const violation = checkClassification({ accountType: "equity", statementType: "profit_loss" });
    expect(violation?.violation).toBe("statement_type_mismatch");
  });

  it("Expense → Balance Sheet is rejected", () => {
    const violation = checkClassification({ accountType: "expense", statementType: "balance_sheet" });
    expect(violation?.violation).toBe("statement_type_mismatch");
  });

  it("Liability → Expense is rejected when the GL proves permanence", () => {
    const violation = checkClassification({ accountType: "expense", glEvidence: permanentEv });
    expect(violation?.violation).toBe("contradicts_gl_permanence");
  });

  it("Income → Liability is rejected when the document says otherwise", () => {
    const violation = checkClassification({ accountType: "liability", documentAccountType: "income" });
    expect(violation?.violation).toBe("contradicts_document");
  });

  it('rejects "Retained Earnings → expense" without naming the account', () => {
    const violation = checkClassification({ accountType: "expense", glEvidence: permanentEv });
    expect(violation?.violation).toBe("contradicts_gl_permanence");

    // The rules must hold for any ERP, language and industry, so the module may
    // not contain a list of account names. This is the guard that keeps a
    // convenient special case from being added later.
    const code = sourceOf("coa-constraints.ts");
    for (const banned of [/retained\s*earnings/i, /owner\s*draw/i, /net\s*income/i, /payroll/i, /interest/i]) {
      expect(banned.test(code), `constraints must not hardcode ${banned}`).toBe(false);
    }
  });

  it("accepts a CORRECT classification on the same evidence", () => {
    for (const type of ["equity", "asset", "liability"]) {
      expect(checkClassification({ accountType: type, glEvidence: permanentEv })).toBeNull();
    }
  });

  it("leaves an account with no evidence completely unconstrained", () => {
    for (const type of ["asset", "liability", "equity", "income", "cogs", "expense"]) {
      expect(checkClassification({ accountType: type }), `${type} must pass`).toBeNull();
    }
  });

  it("rejects a type that is not one of the six", () => {
    const violation = checkClassification({ accountType: "revenue" });
    expect(violation?.violation).toBe("unknown_account_type");
  });

  it("treats a claim of nothing as needs-review, not as a violation", () => {
    // Distinct from an unknown type: nothing was claimed, so there is nothing
    // to contradict. Handled upstream as needs-review.
    expect(checkClassification({ accountType: null })).toBeNull();
    expect(checkClassification({ accountType: "" })).toBeNull();
  });

  it("matches the six types case- and whitespace-insensitively", () => {
    expect(statementForAccountType("  EQUITY ")).toBe("balance_sheet");
    expect(statementForAccountType("Cogs")).toBe("profit_loss");
    expect(statementForAccountType(null)).toBeNull();
  });
});

describe("evidence narrows in priority order and the classifier can never widen it", () => {
  it("a document section collapses the allowed set to exactly that type", () => {
    expect(allowedAccountTypes({ documentAccountType: "income" }).allowed).toEqual(["income"]);
  });

  it("GL permanence narrows to the three Balance Sheet types", () => {
    const ev = buildGlEvidence([opening("X", 2025, 10)]).get("x")!;
    expect(allowedAccountTypes({ glEvidence: ev }).allowed).toEqual(["asset", "liability", "equity"]);
  });

  it("DROPS a hierarchy hint that contradicts proven evidence", () => {
    const ev = buildGlEvidence([opening("X", 2025, 10)]).get("x")!;
    const { allowed, basis } = allowedAccountTypes({
      glEvidence: ev,
      hierarchyAccountTypes: ["expense"],
    });

    // The proof must survive; the weaker hint must not empty the set.
    expect(allowed).toEqual(["asset", "liability", "equity"]);
    expect(basis.some((b) => b.includes("sibling"))).toBe(false);
  });

  it("applies a hierarchy hint that agrees with the proof", () => {
    const ev = buildGlEvidence([opening("X", 2025, 10)]).get("x")!;
    const { allowed, basis } = allowedAccountTypes({
      glEvidence: ev,
      hierarchyAccountTypes: ["equity"],
    });

    expect(allowed).toEqual(["equity"]);
    expect(basis.some((b) => b.includes("sibling"))).toBe(true);
  });

  it("lets the document outrank the ledger when the two disagree", () => {
    const ev = buildGlEvidence([opening("X", 2025, 10)]).get("x")!;
    // Intersection semantics: an income document section and a permanence proof
    // cannot both hold, and the result is an empty set rather than a silent
    // pick. Empty is a real answer — it means the inputs contradict.
    expect(allowedAccountTypes({ glEvidence: ev, documentAccountType: "income" }).allowed).toEqual([]);
  });

  it("records why each constraint applied", () => {
    const ev = buildGlEvidence([opening("X", 2025, 10)]).get("x")!;
    const { basis } = allowedAccountTypes({ glEvidence: ev });
    expect(basis).toHaveLength(1);
    expect(basis[0]).toContain("carried across a fiscal year");
  });

  it("means no constraint when there is no evidence at all", () => {
    expect(allowedAccountTypes({}).allowed).toBeNull();
    expect(allowedAccountTypes().allowed).toBeNull();
  });
});

describe("account-number block consensus", () => {
  const peers = [
    { accountNumber: "30010", accountType: "equity" },
    { accountNumber: "30020", accountType: "equity" },
    { accountNumber: "60010", accountType: "expense" },
  ];

  it("lends its type when the block is unanimous", () => {
    const got = inferTypeFromAccountNumberBlock({ accountNumber: "30030" }, peers);
    expect(got?.accountType).toBe("equity");
    expect(got?.basis).toContain("number block");
  });

  it("is not evidence when the block disagrees", () => {
    const mixed = [
      { accountNumber: "30010", accountType: "equity" },
      { accountNumber: "30020", accountType: "liability" },
    ];
    expect(inferTypeFromAccountNumberBlock({ accountNumber: "30030" }, mixed)).toBeNull();
  });

  it("discards a consensus outside the allowed set", () => {
    const got = inferTypeFromAccountNumberBlock({ accountNumber: "30030" }, peers, {
      allowed: ["income"],
    });
    expect(got).toBeNull(); // must never override harder evidence
  });

  it("yields nothing for an account with no number", () => {
    expect(inferTypeFromAccountNumberBlock({ accountNumber: null }, peers)).toBeNull();
    expect(inferTypeFromAccountNumberBlock({ accountNumber: "7" }, peers)).toBeNull();
    expect(inferTypeFromAccountNumberBlock(null, peers)).toBeNull();
  });

  it("yields nothing when too few peers are resolved", () => {
    const lonely = [{ accountNumber: "30010", accountType: "equity" }];
    expect(inferTypeFromAccountNumberBlock({ accountNumber: "30030" }, lonely)).toBeNull();
    expect(inferTypeFromAccountNumberBlock({ accountNumber: "30030" }, null)).toBeNull();
  });

  it("prefers the tightest block that still has enough peers", () => {
    // 3001* is unanimous equity; 3* would also sweep in the expense account.
    const wide = [
      { accountNumber: "30011", accountType: "equity" },
      { accountNumber: "30012", accountType: "equity" },
      { accountNumber: "39999", accountType: "expense" },
    ];
    const got = inferTypeFromAccountNumberBlock({ accountNumber: "30013" }, wide);
    expect(got?.accountType).toBe("equity");
    expect(got?.basis).toContain("3001*");
  });

  it("ignores peers carrying no resolved type", () => {
    const partial = [
      { accountNumber: "30010", accountType: "equity" },
      { accountNumber: "30020", accountType: null },
      { accountNumber: "30021", accountType: "equity" },
    ];
    expect(inferTypeFromAccountNumberBlock({ accountNumber: "30030" }, partial)?.accountType).toBe(
      "equity",
    );
  });

  it("does not count the account itself as its own peer", () => {
    const selfOnly = [
      { accountNumber: "30030", accountType: "equity" },
      { accountNumber: "30030", accountType: "equity" },
    ];
    expect(inferTypeFromAccountNumberBlock({ accountNumber: "30030" }, selfOnly)).toBeNull();
  });

  it("strips non-digits from an account number before comparing", () => {
    const got = inferTypeFromAccountNumberBlock({ accountNumber: "300-30" }, peers);
    expect(got?.accountType).toBe("equity");
  });
});
