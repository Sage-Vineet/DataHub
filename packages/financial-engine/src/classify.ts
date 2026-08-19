import type { Account, EbitdaRole } from "./types.js";

/**
 * Assign EBITDA roles to chart-of-accounts records.
 *
 * `QE - 0004` requires the EBIT lines to come from a stored account-level
 * classification. Something has to put it there, and hand-flagging every
 * account on every engagement does not scale — so this runs server-side over
 * the chart of accounts and writes the flag.
 *
 * TWO RULES GOVERN THE DESIGN, both learned from the bridge this replaces:
 *
 *  1. **A phrase must be matched, never a bare word.** The previous
 *     implementation treated "tax" as a whole-word match and swept Meals Tax,
 *     Real estate taxes and Taxes & Licenses into income tax expense —
 *     $83,981.56 of invented add-back on a company with no income tax at all.
 *
 *  2. **Ambiguity yields nothing, and says so.** An account that matches no
 *     rule is returned unclassified with a reason, not assigned a best guess.
 *     Only `high` confidence is applied automatically; `low` is a suggestion a
 *     human confirms. A missing add-back is visible on review; an invented one
 *     is not.
 */

export type Confidence = "high" | "low";

export interface Classification {
  accountId: string;
  accountName: string;
  /** Null when nothing matched, or when only an exclusion did. */
  role: EbitdaRole | null;
  confidence: Confidence;
  /** Identifier of the rule (or exclusion) that decided this. */
  rule: string;
  /** Human-readable justification, shown in the review UI. */
  reason: string;
}

interface Rule {
  id: string;
  role: EbitdaRole;
  confidence: Confidence;
  /** Normalized phrases; a name matches when it CONTAINS one of them. */
  phrases: string[];
  /** Only applies to accounts of this side of the P&L, when set. */
  requires?: "income" | "expense";
  reason: string;
}

/** Lowercase, strip punctuation, collapse whitespace. "Interest Paid" → "interest paid". */
export function normalizeAccountName(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Taxes that are operating costs, not income taxes.
 *
 * Checked BEFORE the income-tax rules, so an account has to survive this list
 * to be considered an income tax. This is the specific defect the engine
 * exists to prevent, so the list is deliberately long and the test suite pins
 * every entry.
 */
const OPERATING_TAX_PHRASES = [
  "sales tax", "use tax", "sales and use tax",
  "payroll tax", "employment tax", "unemployment tax", "employer tax", "fica",
  "futa", "suta", "withholding tax", "employer payroll",
  "real estate tax", "property tax", "personal property tax", "tangible tax",
  "meals tax", "meal tax", "food tax", "beverage tax", "liquor tax",
  "occupancy tax", "lodging tax", "hotel tax", "room tax",
  "excise tax", "fuel tax", "gas tax", "highway tax", "road tax",
  "franchise tax", "business tax", "license tax", "privilege tax",
  "taxes and licenses", "tax and license", "taxes licenses", "license and tax",
  "tax preparation", "tax prep", "tax service", "tax advisory", "tax consulting",
  "tax penalty", "tax penalties", "tax interest",
  "capital stock tax", "gross receipts tax", "b o tax", "commercial rent tax",
];

/**
 * Balance-sheet-shaped names that can appear on a mis-classified P&L.
 * Accumulated depreciation is a contra-asset; adding it back would double-count.
 */
const CONTRA_PHRASES = ["accumulated depreciation", "accumulated amortization"];

const RULES: Rule[] = [
  // ── Income tax ────────────────────────────────────────────────────────────
  {
    id: "income-tax.explicit",
    role: "income_tax",
    confidence: "high",
    requires: "expense",
    phrases: [
      "income tax", "income taxes",
      "federal income tax", "state income tax", "local income tax",
      "provision for income tax", "provision for taxes",
      "corporate income tax", "corporate tax",
      "deferred income tax", "deferred tax",
      "current tax expense", "tax expense income",
    ],
    reason: "Name states an income tax, which is added back to reach EBITDA.",
  },

  // ── Interest ──────────────────────────────────────────────────────────────
  {
    id: "interest-income.explicit",
    role: "interest_income",
    confidence: "high",
    requires: "income",
    phrases: ["interest income", "interest earned", "interest revenue", "dividend income"],
    reason: "Non-operating interest income, deducted when reaching EBITDA.",
  },
  {
    id: "interest-expense.explicit",
    role: "interest_expense",
    confidence: "high",
    requires: "expense",
    phrases: [
      "interest expense", "interest paid", "interest on loan", "loan interest",
      "mortgage interest", "note interest", "interest on note", "interest on debt",
      "finance charge", "financing interest",
    ],
    reason: "Interest cost of the seller's capital structure, added back to reach EBITDA.",
  },
  {
    // A bare "Interest" account on the expense side. Real, but broad enough to
    // deserve a look before it moves the number.
    id: "interest-expense.bare",
    role: "interest_expense",
    confidence: "low",
    requires: "expense",
    phrases: ["interest"],
    reason: "Named only \"interest\" — confirm this is borrowing cost, not a fee.",
  },

  // ── Depreciation & amortization ───────────────────────────────────────────
  {
    id: "depreciation.explicit",
    role: "depreciation",
    confidence: "high",
    requires: "expense",
    phrases: ["depreciation", "depreciation expense"],
    reason: "Non-cash charge for historical capital expenditure.",
  },
  {
    id: "amortization.explicit",
    role: "amortization",
    confidence: "high",
    requires: "expense",
    phrases: ["amortization", "amortisation"],
    reason: "Non-cash charge for historical intangible acquisition.",
  },

  // ── Owner compensation ────────────────────────────────────────────────────
  {
    id: "owner-comp.explicit",
    role: "owner_compensation",
    confidence: "high",
    requires: "expense",
    phrases: [
      "officer compensation", "officers compensation", "officer salary",
      "officers salary", "officer wages", "officers wages",
      "owner compensation", "owners compensation", "owner salary", "owners salary",
      "shareholder compensation", "member compensation", "guaranteed payment",
    ],
    reason: "Owner compensation — normalized against a market-rate replacement.",
  },
];

/** Combined depreciation+amortization names route to depreciation with a note. */
const COMBINED_DA = ["depreciation and amortization", "depreciation amortization"];

function containsAny(haystack: string, phrases: string[]): string | null {
  for (const phrase of phrases) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

/** Classify one account. Never throws; an unmatched account is a valid result. */
export function classifyAccount(account: Account): Classification {
  const base = { accountId: account.id, accountName: account.name };
  const name = normalizeAccountName(account.name);

  if (account.statementType !== "profit_loss") {
    return {
      ...base, role: null, confidence: "high", rule: "skip.not-profit-loss",
      reason: "Balance-sheet account — the EBITDA bridge only classifies P&L accounts.",
    };
  }

  const contra = containsAny(name, CONTRA_PHRASES);
  if (contra) {
    return {
      ...base, role: null, confidence: "high", rule: "exclude.contra-asset",
      reason: `Matches "${contra}" — a contra-asset balance, not a P&L charge.`,
    };
  }

  // Operating taxes are ruled out before income tax is ever considered. This
  // ordering is the whole point of the module.
  const operatingTax = containsAny(name, OPERATING_TAX_PHRASES);
  if (operatingTax) {
    return {
      ...base, role: null, confidence: "high", rule: "exclude.operating-tax",
      reason: `Matches "${operatingTax}" — an operating tax, not income tax, so it stays in earnings.`,
    };
  }

  const combined = containsAny(name, COMBINED_DA);
  if (combined) {
    return {
      ...base, role: "depreciation", confidence: "high", rule: "depreciation.combined",
      reason: "Combined depreciation and amortization line, added back in full.",
    };
  }

  for (const rule of RULES) {
    if (rule.requires && account.accountType !== rule.requires) continue;
    const phrase = containsAny(name, rule.phrases);
    if (!phrase) continue;
    return {
      ...base, role: rule.role, confidence: rule.confidence, rule: rule.id,
      reason: `${rule.reason} (matched "${phrase}")`,
    };
  }

  return {
    ...base, role: null, confidence: "high", rule: "unmatched",
    reason: "No rule matched — left out of the bridge rather than guessed at.",
  };
}

export interface ClassificationReport {
  /** High-confidence results safe to apply without review. */
  applied: Classification[];
  /** Matched, but wants a human before it moves the number. */
  suggested: Classification[];
  /** Deliberately left out, with the reason why. */
  unclassified: Classification[];
}

/**
 * Classify a chart of accounts.
 *
 * Only P&L accounts appear in the report; balance-sheet accounts are skipped
 * silently because they are not part of the bridge.
 */
export function classifyAccounts(accounts: Account[]): ClassificationReport {
  const report: ClassificationReport = { applied: [], suggested: [], unclassified: [] };
  for (const account of accounts) {
    if (account.statementType !== "profit_loss") continue;
    const result = classifyAccount(account);
    if (result.role && result.confidence === "high") report.applied.push(result);
    else if (result.role) report.suggested.push(result);
    else report.unclassified.push(result);
  }
  return report;
}
