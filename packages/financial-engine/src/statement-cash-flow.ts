/**
 * Cash flow derived from two balance sheets and an income statement.
 *
 * Distinct from `cash-flow.ts`, which builds a cash flow from the general
 * ledger. This one has no ledger to work from: its inputs are STATEMENTS that
 * somebody uploaded as a PDF or a spreadsheet, already summarised into named
 * lines. All it knows about an account is what the line is called.
 *
 * That constraint drives the whole design. Classification is by name, name
 * matching is approximate, and an approximate classification that silently
 * puts money in the wrong section produces a statement that still reconciles
 * and is still wrong. So the classification is made explicit, exclusive, and
 * reported — the caller can see which lines were recognised as what, and which
 * were not recognised at all.
 */

/** A line on an uploaded statement, as extraction produced it. */
export interface StatementNode {
  name: string;
  amount?: number | null;
  type?: string | null;
  children?: StatementNode[] | null;
}

/**
 * What a balance-sheet line is, for cash-flow purposes.
 *
 * Deliberately coarser than a chart of accounts. A cash flow only needs to
 * know which section a movement belongs in and which direction it pushes cash.
 */
export type CashFlowBucket =
  | "cash"
  | "accounts_receivable"
  | "inventory"
  | "other_current_assets"
  | "accounts_payable"
  | "accrued_expenses"
  | "other_current_liabilities"
  | "fixed_assets"
  | "deposits"
  | "investments"
  | "debt"
  | "paid_in_capital";

/**
 * The classification table, IN PRIORITY ORDER.
 *
 * One ordered list rather than a bucket-per-array, because with separate
 * arrays every line is tested against every bucket and a line matching two of
 * them is counted twice — in two different sections, pushing cash in two
 * directions. Legacy had exactly that: "Customer Deposits" matches both
 * `/^customer deposits?$/` under other current liabilities and `/\bdeposits?\b/`
 * under security deposits, so a customer deposit moved operating cash AND
 * investing cash, and the two partially cancelled. The statement still
 * reconciled. It was still attributing the money to the wrong activity.
 *
 * Ordered, first match wins, and double counting is impossible by
 * construction rather than by nobody having noticed yet.
 *
 * The ordering rule is specific before general. An exact-name pattern for a
 * bucket comes before any loose `\bword\b` pattern for another, so a line
 * called exactly what it is never falls to a catch-all.
 */
const CLASSIFIERS: ReadonlyArray<{ bucket: CashFlowBucket; pattern: RegExp }> = [
  // Exact names first, across all buckets.
  { bucket: "cash", pattern: /^total cash( and cash equivalents)?$/i },
  { bucket: "cash", pattern: /^cash (and|&) cash equivalents$/i },
  { bucket: "cash", pattern: /^total bank accounts?$/i },
  { bucket: "cash", pattern: /^bank accounts?$/i },
  { bucket: "cash", pattern: /^cash$/i },
  { bucket: "accounts_receivable", pattern: /^(total )?accounts receivable( \(a\/r\))?$/i },
  { bucket: "accounts_receivable", pattern: /^trade (accounts )?receivable$/i },
  { bucket: "inventory", pattern: /^(total )?inventories?$/i },
  { bucket: "inventory", pattern: /^merchandise inventory$/i },
  { bucket: "accounts_payable", pattern: /^(total )?accounts payable( \(a\/p\))?$/i },
  { bucket: "accounts_payable", pattern: /^trade payables$/i },
  { bucket: "accrued_expenses", pattern: /^(total )?accrued (liabilities|expenses|payroll)$/i },
  { bucket: "other_current_assets", pattern: /^(total )?other current assets?$/i },
  { bucket: "other_current_assets", pattern: /^prepaid (expenses?|insurance|rent)$/i },
  // Before `deposits`. A customer deposit is money owed to a customer, not a
  // deposit we placed with somebody — it is working capital, not investing.
  { bucket: "other_current_liabilities", pattern: /^(total )?other current liabilities$/i },
  { bucket: "other_current_liabilities", pattern: /^deferred revenue$/i },
  { bucket: "other_current_liabilities", pattern: /^customer (deposits?|advances?)$/i },
  { bucket: "fixed_assets", pattern: /^(total |net )?property,? plant( and|&) equipment,? net$/i },
  { bucket: "fixed_assets", pattern: /^(net |total )?property and equipment$/i },
  { bucket: "fixed_assets", pattern: /^(net |total )?fixed assets?$/i },
  { bucket: "deposits", pattern: /^(security |tenant )?deposits?$/i },
  { bucket: "investments", pattern: /^(total )?long.?term investments?$/i },
  { bucket: "investments", pattern: /^(total )?investments?$/i },
  { bucket: "investments", pattern: /^marketable securities$/i },
  { bucket: "debt", pattern: /^(total )?line of credit$/i },
  { bucket: "debt", pattern: /^(total )?long.?term (debt|notes? payable|loans? payable)$/i },
  { bucket: "debt", pattern: /^(total )?long.?term liabilities$/i },
  { bucket: "debt", pattern: /^(total )?notes? payable$/i },
  { bucket: "debt", pattern: /^(total )?loans? payable$/i },
  { bucket: "paid_in_capital", pattern: /^(additional )?paid.?in capital$/i },
  { bucket: "paid_in_capital", pattern: /^(total )?owner.?s? (equity|capital|investment)$/i },
  { bucket: "paid_in_capital", pattern: /^common stock$/i },

  // Then the loose ones, same order of specificity.
  { bucket: "cash", pattern: /cash and cash equivalents/i },
  { bucket: "accounts_receivable", pattern: /accounts receivable/i },
  { bucket: "accounts_payable", pattern: /accounts payable/i },
  { bucket: "accrued_expenses", pattern: /accrued (liabilities|expenses)/i },
  { bucket: "accrued_expenses", pattern: /\baccrued\b.*\b(payroll|salaries|wages)\b/i },
  { bucket: "other_current_assets", pattern: /other current assets?/i },
  { bucket: "other_current_assets", pattern: /prepaid expenses?/i },
  { bucket: "other_current_liabilities", pattern: /other current liabilities/i },
  { bucket: "other_current_liabilities", pattern: /deferred revenue/i },
  { bucket: "fixed_assets", pattern: /property.*equipment.*net/i },
  { bucket: "fixed_assets", pattern: /property.*(plant|equipment)/i },
  { bucket: "investments", pattern: /long.?term investments?/i },
  { bucket: "debt", pattern: /line of credit/i },
  { bucket: "debt", pattern: /\brevolver\b/i },
  { bucket: "debt", pattern: /long.?term (debt|notes? payable|loans? payable)/i },
  { bucket: "debt", pattern: /long.?term liabilities/i },
  { bucket: "debt", pattern: /notes? payable/i },
  { bucket: "debt", pattern: /loans? payable/i },
  { bucket: "debt", pattern: /\b(bank|director.?s?|shareholder.?s?|partner.?s?|vehicle|equipment|sba|term)\s+loan\b/i },
  { bucket: "debt", pattern: /\bcredit\s+(line|facility)\b/i },
  { bucket: "debt", pattern: /\bmortgage\b/i },
  { bucket: "debt", pattern: /\bborrowing/i },
  { bucket: "paid_in_capital", pattern: /paid.?in capital/i },
  { bucket: "paid_in_capital", pattern: /owner.?s? (equity|capital|investment)/i },
  { bucket: "paid_in_capital", pattern: /common stock/i },
  { bucket: "inventory", pattern: /inventory/i },
  { bucket: "accounts_receivable", pattern: /\breceivables?\b/i },
  { bucket: "fixed_assets", pattern: /\btotal fixed assets?\b/i },
  { bucket: "fixed_assets", pattern: /\bfixed assets?\b/i },
  { bucket: "deposits", pattern: /security deposits?/i },
  { bucket: "deposits", pattern: /\bdeposits?\b/i },
  { bucket: "investments", pattern: /\binvestments?\b/i },
  { bucket: "cash", pattern: /\btotal cash\b/i },
  { bucket: "cash", pattern: /\bbank accounts?\b/i },
  { bucket: "cash", pattern: /\bcash\b/i },
];

/** Income-statement lines, which are read by name too but never net out. */
const NET_INCOME = [
  /^net (income|profit|earnings?)$/i,
  /^net income \(loss\)$/i,
  /^net (income|profit|loss)$/i,
  /net income/i,
  /net profit/i,
];
const DEPRECIATION = [
  /^depreciation( and amortization| & amortization)?$/i,
  /^depreciation$/i,
  /depreciation (and|&) amortization/i,
  /\bdepreciation\b/i,
];
const AMORTIZATION = [/^amortization( of (intangibles?|goodwill|loan costs?))?$/i, /\bamortization\b/i];
const DISTRIBUTIONS = [
  /^owner.?s? draws?$/i,
  /^(owner.?s? )?distributions?$/i,
  /^dividends? paid$/i,
  /owner.?s? (draws?|distributions?)/i,
  /dividends? paid/i,
  /\bdistributions?\b/i,
  /\bdraws?\b/i,
];

/**
 * Which bucket a line belongs to, or null if nothing recognises it.
 *
 * Exported because "what did you think this line was?" is a question a person
 * staring at a cash flow that will not reconcile needs to be able to ask.
 */
export function classifyStatementLine(name: string): CashFlowBucket | null {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  for (const { bucket, pattern } of CLASSIFIERS) {
    if (pattern.test(trimmed)) return bucket;
  }
  return null;
}

/** Every bucket a line matches — for reporting a pattern set that overlaps. */
export function bucketsMatching(name: string): CashFlowBucket[] {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return [];
  const found = new Set<CashFlowBucket>();
  for (const { bucket, pattern } of CLASSIFIERS) {
    if (pattern.test(trimmed)) found.add(bucket);
  }
  return [...found];
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The leaves of a statement tree.
 *
 * Leaves only, because a parent's amount is the sum of its children and
 * counting both doubles every figure under it. A node with children is a
 * subtotal whatever its `type` says.
 */
export function leavesOf(nodes: readonly StatementNode[] | null | undefined): StatementNode[] {
  const out: StatementNode[] = [];
  const walk = (list: readonly StatementNode[]): void => {
    for (const node of list) {
      if (node.children && node.children.length > 0) walk(node.children);
      else out.push(node);
    }
  };
  walk(nodes ?? []);
  return out;
}

const amountOf = (node: StatementNode): number =>
  typeof node.amount === "number" && Number.isFinite(node.amount) ? node.amount : 0;

/**
 * A statement line's name, trimmed.
 *
 * `StatementNode.name` is typed nullable because extraction writes these rows
 * and a line with no label is a shape a model can produce. Every read of it
 * wants the same thing — a trimmed string, empty when there is nothing — and
 * spelling that out at each of the ten sites made ten branches out of one
 * decision.
 */
const nameOf = (node: StatementNode): string => String(node.name ?? "").trim();

const sumMatching = (leaves: readonly StatementNode[], patterns: readonly RegExp[]): number =>
  round2(
    leaves
      .filter((leaf) => patterns.some((p) => p.test(nameOf(leaf))))
      .reduce((total, leaf) => total + amountOf(leaf), 0),
  );

/** Everything in one bucket, summed. */
function sumBucket(byBucket: Map<CashFlowBucket, StatementNode[]>, bucket: CashFlowBucket): number {
  return round2((byBucket.get(bucket) ?? []).reduce((total, leaf) => total + amountOf(leaf), 0));
}

function group(leaves: readonly StatementNode[]): Map<CashFlowBucket, StatementNode[]> {
  const byBucket = new Map<CashFlowBucket, StatementNode[]>();
  for (const leaf of leaves) {
    const bucket = classifyStatementLine(nameOf(leaf));
    if (!bucket) continue;
    const existing = byBucket.get(bucket);
    if (existing) existing.push(leaf);
    else byBucket.set(bucket, [leaf]);
  }
  return byBucket;
}

export interface CashFlowActivity {
  label: string;
  value: number;
}

/**
 * Why a figure is what it is.
 *
 * Kept in the result rather than logged. A cash flow that will not reconcile
 * is the commonest thing to go wrong here, and the answer is almost always a
 * line nobody classified — which is knowable only if the classification is
 * reported to whoever is looking at the statement, not to a server log.
 */
export interface CashFlowTrace {
  line: string;
  bucket: CashFlowBucket | "net_income" | "depreciation" | "amortization" | "distributions";
  current: number;
  prior: number;
  delta: number;
  section: "operating" | "investing" | "financing";
}

export interface StatementCashFlowReconciliation {
  status: "reconciled" | "mismatch";
  /** Computed ending cash minus the balance sheet's own cash line. */
  difference: number;
  computedEndingCash: number;
  balanceSheetCash: number;
  beginningCash: number;
  netCashChange: number;
  sectionTotals: { operating: number; investing: number; financing: number };
  /**
   * Balance-sheet lines nothing recognised.
   *
   * The first thing to look at when the statement does not reconcile: an
   * unclassified line is a movement the cash flow simply did not account for.
   */
  unclassifiedLines: Array<{ name: string; amount: number }>;
  /**
   * Lines that more than one pattern claims.
   *
   * First match wins, so these are not double counted — but a pattern set that
   * overlaps is a pattern set about to classify something wrongly, and saying
   * so is cheaper than finding out from a figure.
   */
  ambiguousLines: Array<{ name: string; buckets: CashFlowBucket[]; assigned: CashFlowBucket }>;
  trace: CashFlowTrace[];
}

export interface StatementCashFlow {
  fiscalYear: number;
  method: "indirect";
  operatingActivities: CashFlowActivity[];
  totalOperating: number;
  investingActivities: CashFlowActivity[];
  totalInvesting: number;
  financingActivities: CashFlowActivity[];
  totalFinancing: number;
  netCashChange: number;
  beginningCash: number;
  endingCash: number;
  /** Whether the computed ending cash agrees with the balance sheet's own. */
  cashValidated: boolean;
  reconciliation: StatementCashFlowReconciliation;
}

export interface StatementCashFlowInput {
  /** The prior year's balance sheet. Absent for the first year on file. */
  priorBalanceSheet?: readonly StatementNode[] | null;
  currentBalanceSheet: readonly StatementNode[];
  incomeStatement: readonly StatementNode[];
  fiscalYear: number;
  /**
   * How far the computed ending cash may sit from the balance sheet's own and
   * still count as reconciled, in currency units. Statement figures are
   * rounded to the dollar as often as to the cent, so an exact test fails on
   * presentation rather than on a real break.
   */
  tolerance?: number;
}

/**
 * Build a cash flow statement from uploaded statements, indirect method.
 *
 * With no prior balance sheet there are no movements to measure, so every
 * working-capital and financing change is zero and only the P&L's own
 * non-cash addbacks appear. That is deliberately not an error: the first year
 * a company is on file still has a P&L worth showing, and refusing to produce
 * anything would leave the page blank with no explanation.
 */
export function buildStatementCashFlow(input: StatementCashFlowInput): StatementCashFlow {
  const tolerance = input.tolerance ?? 1;
  const currentLeaves = leavesOf(input.currentBalanceSheet);
  const priorLeaves = leavesOf(input.priorBalanceSheet);
  const incomeLeaves = leavesOf(input.incomeStatement);
  const hasPrior = priorLeaves.length > 0;

  const current = group(currentLeaves);
  const prior = group(priorLeaves);
  const trace: CashFlowTrace[] = [];

  const record = (
    line: string,
    bucket: CashFlowTrace["bucket"],
    curr: number,
    prev: number,
    delta: number,
    section: CashFlowTrace["section"],
  ): void => {
    trace.push({ line, bucket, current: round2(curr), prior: round2(prev), delta: round2(delta), section });
  };

  // ── From the income statement ──────────────────────────────────────────────
  const netIncome = sumMatching(incomeLeaves, NET_INCOME);
  const depreciation = sumMatching(incomeLeaves, DEPRECIATION);

  // A line called "Depreciation and Amortization" is both. Adding the
  // amortization patterns on top of it would count the amortization twice, so
  // it is only added when no depreciation line already absorbed it.
  const combined = incomeLeaves.some(
    (leaf) =>
      DEPRECIATION.some((p) => p.test(nameOf(leaf))) &&
      /amortization/i.test(nameOf(leaf)),
  );
  const amortization = combined ? 0 : sumMatching(incomeLeaves, AMORTIZATION);

  record("Net Income", "net_income", netIncome, 0, netIncome, "operating");
  record("Depreciation", "depreciation", depreciation, 0, depreciation, "operating");
  if (amortization !== 0) {
    record("Amortization", "amortization", amortization, 0, amortization, "operating");
  }

  // ── Working capital ────────────────────────────────────────────────────────
  /**
   * A movement, signed for its effect on cash.
   *
   * An asset going up consumes cash (sign −1); a liability going up provides
   * it (sign +1). Getting this backwards is the classic way to produce a cash
   * flow that is exactly twice wrong in the working-capital section.
   */
  const movement = (label: string, bucket: CashFlowBucket, sign: 1 | -1): number => {
    if (!hasPrior) return 0;
    const curr = sumBucket(current, bucket);
    const prev = sumBucket(prior, bucket);
    const delta = round2(sign * (curr - prev));
    record(label, bucket, curr, prev, delta, "operating");
    return delta;
  };

  const changeAR = movement("Accounts Receivable", "accounts_receivable", -1);
  const changeInventory = movement("Inventory", "inventory", -1);
  const changeOtherCA = movement("Other Current Assets", "other_current_assets", -1);
  const changeAP = movement("Accounts Payable", "accounts_payable", 1);
  const changeAccrued = movement("Accrued Expenses", "accrued_expenses", 1);
  const changeOtherCL = movement("Other Current Liabilities", "other_current_liabilities", 1);

  const totalOperating = round2(
    netIncome +
      depreciation +
      amortization +
      changeAR +
      changeInventory +
      changeOtherCA +
      changeAP +
      changeAccrued +
      changeOtherCL,
  );

  // ── Investing ──────────────────────────────────────────────────────────────
  const currentFixed = sumBucket(current, "fixed_assets");
  const priorFixed = hasPrior ? sumBucket(prior, "fixed_assets") : 0;

  let purchaseOfFixedAssets = 0;
  let saleOfFixedAssets = 0;
  if (hasPrior) {
    const netChange = round2(currentFixed - priorFixed);
    // Under net PP&E reporting the balance falls by depreciation every year
    // even when nothing was bought or sold, so the raw movement understates
    // capex by exactly the depreciation:
    //   ending = beginning + capex − depreciation
    //   capex  = (ending − beginning) + depreciation
    // Without the addback a company that spent its depreciation looks like a
    // company that spent nothing.
    const capex = depreciation > 0 ? round2(netChange + depreciation) : netChange;
    if (capex > 0) {
      purchaseOfFixedAssets = -capex;
      record("Fixed Assets (purchase)", "fixed_assets", currentFixed, priorFixed, purchaseOfFixedAssets, "investing");
    } else if (capex < 0) {
      saleOfFixedAssets = -capex;
      record("Fixed Assets (sale)", "fixed_assets", currentFixed, priorFixed, saleOfFixedAssets, "investing");
    }
  }

  const depositsMovement = hasPrior
    ? round2(-(sumBucket(current, "deposits") - sumBucket(prior, "deposits")))
    : 0;
  if (hasPrior) {
    record(
      "Deposits",
      "deposits",
      sumBucket(current, "deposits"),
      sumBucket(prior, "deposits"),
      depositsMovement,
      "investing",
    );
  }

  const investmentsMovement = hasPrior
    ? round2(-(sumBucket(current, "investments") - sumBucket(prior, "investments")))
    : 0;
  if (hasPrior) {
    record(
      "Investments",
      "investments",
      sumBucket(current, "investments"),
      sumBucket(prior, "investments"),
      investmentsMovement,
      "investing",
    );
  }

  const totalInvesting = round2(
    purchaseOfFixedAssets + saleOfFixedAssets + depositsMovement + investmentsMovement,
  );

  // ── Financing ──────────────────────────────────────────────────────────────
  const financingActivities: CashFlowActivity[] = [];

  // Every debt account on its own line, never aggregated. A company that drew
  // £200k on a facility and repaid £200k of a term loan moved £400k of cash;
  // netting them to zero hides both movements, and which loans grew is the
  // question a buyer actually asks.
  if (hasPrior) {
    const currentDebt = new Map(
      (current.get("debt") ?? []).map((leaf) => [nameOf(leaf), amountOf(leaf)]),
    );
    const priorDebt = new Map(
      (prior.get("debt") ?? []).map((leaf) => [nameOf(leaf), amountOf(leaf)]),
    );
    for (const name of [...new Set([...currentDebt.keys(), ...priorDebt.keys()])].sort()) {
      const curr = currentDebt.get(name) ?? 0;
      const prev = priorDebt.get(name) ?? 0;
      const delta = round2(curr - prev);
      if (delta === 0) continue;
      financingActivities.push({ label: `Loans - ${name}`, value: delta });
      record(`Loan: ${name}`, "debt", curr, prev, delta, "financing");
    }
  }

  const currentEquity = sumBucket(current, "paid_in_capital");
  const priorEquity = hasPrior ? sumBucket(prior, "paid_in_capital") : 0;
  const equityContribution = hasPrior ? round2(currentEquity - priorEquity) : 0;
  if (equityContribution !== 0) {
    record(
      "Equity Contribution",
      "paid_in_capital",
      currentEquity,
      priorEquity,
      equityContribution,
      "financing",
    );
  }
  financingActivities.push({ label: "Equity Contribution", value: equityContribution });

  // Draws come from the P&L, never from a retained-earnings movement: retained
  // earnings moves by profit AND by draws together, so reading draws off it
  // double counts the year's profit.
  const distributions = sumMatching(incomeLeaves, DISTRIBUTIONS);
  if (distributions !== 0) {
    record("Distributions", "distributions", distributions, 0, -distributions, "financing");
  }
  // Rounded rather than simply negated: `-0` is what negating an absent
  // distribution produces, it renders as "-0" on a statement, and it is not
  // `Object.is`-equal to zero for anything comparing downstream.
  financingActivities.push({ label: "Distributions", value: round2(-distributions) });

  const totalFinancing = round2(
    financingActivities.reduce((total, activity) => total + activity.value, 0),
  );

  // ── Does it reconcile? ─────────────────────────────────────────────────────
  const beginningCash = hasPrior ? sumBucket(prior, "cash") : 0;
  const netCashChange = round2(totalOperating + totalInvesting + totalFinancing);
  const endingCash = round2(beginningCash + netCashChange);
  const balanceSheetCash = sumBucket(current, "cash");
  const difference = round2(endingCash - balanceSheetCash);
  // A company can genuinely hold no cash, and legacy's `bsEndingCash !== 0`
  // gate meant such a company could never reconcile however correct the
  // statement was — it reported a permanent NO_CASH_BALANCE instead.
  const cashValidated = Math.abs(difference) <= tolerance;

  const classifiedNames = new Set(
    [...current.values()].flat().map((leaf) => nameOf(leaf)),
  );
  const unclassifiedLines = currentLeaves
    .filter((leaf) => !classifiedNames.has(nameOf(leaf)))
    .map((leaf) => ({ name: nameOf(leaf), amount: amountOf(leaf) }));

  const ambiguousLines: StatementCashFlowReconciliation["ambiguousLines"] = [];
  for (const leaf of currentLeaves) {
    const name = nameOf(leaf);
    const buckets = bucketsMatching(name);
    if (buckets.length > 1) {
      ambiguousLines.push({ name, buckets, assigned: classifyStatementLine(name)! });
    }
  }

  return {
    fiscalYear: input.fiscalYear,
    method: "indirect",
    operatingActivities: [
      { label: "Net Income", value: netIncome },
      { label: "Depreciation", value: depreciation },
      { label: "Amortization", value: amortization },
      { label: "Change in Accounts Receivable", value: changeAR },
      { label: "Change in Inventory", value: changeInventory },
      { label: "Change in Accounts Payable", value: changeAP },
      { label: "Change in Accrued Expenses", value: changeAccrued },
      { label: "Change in Other Current Assets", value: changeOtherCA },
      { label: "Change in Other Current Liabilities", value: changeOtherCL },
    ],
    totalOperating,
    investingActivities: [
      { label: "Purchase of Fixed Assets", value: purchaseOfFixedAssets },
      { label: "Sale of Fixed Assets", value: saleOfFixedAssets },
      { label: "Deposits", value: depositsMovement },
      { label: "Investments", value: investmentsMovement },
    ],
    totalInvesting,
    financingActivities,
    totalFinancing,
    netCashChange,
    beginningCash,
    endingCash,
    cashValidated,
    reconciliation: {
      status: cashValidated ? "reconciled" : "mismatch",
      difference,
      computedEndingCash: endingCash,
      balanceSheetCash,
      beginningCash,
      netCashChange,
      sectionTotals: {
        operating: totalOperating,
        investing: totalInvesting,
        financing: totalFinancing,
      },
      unclassifiedLines,
      ambiguousLines,
      trace,
    },
  };
}
