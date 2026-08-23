/**
 * Working out which spreadsheet column is which.
 *
 * Somebody uploads a general ledger export and it has whatever headers their
 * accounting system chose — "Distribution Account", "Txn Date", "Money Out".
 * Before a single row can be read, each column has to be matched to a field.
 *
 * A person can always override it, and that is the point: this is a DEFAULT,
 * and the cost of a wrong one is a mis-imported ledger nobody notices until
 * the balance sheet stops balancing. So a low-confidence guess is reported as
 * low-confidence rather than quietly applied — `canAutoProcess` is what the
 * upload screen reads to decide whether to ask.
 *
 * Pure: columns and sample rows in, a mapping out. Every weight and threshold
 * below is legacy's, kept deliberately — they were tuned against real exports,
 * and changing them during a port would silently re-map every future upload
 * with nothing to compare against.
 */

/** Without these there is no ledger to read. */
export const REQUIRED_FIELDS = ["date", "account_name", "debit", "credit"] as const;

export const OPTIONAL_FIELDS = [
  "split_amount",
  "description",
  "transaction_type",
  "balance",
  "reference",
  "account_type",
  "account_number",
] as const;

export type MappingField = (typeof REQUIRED_FIELDS)[number] | (typeof OPTIONAL_FIELDS)[number];

export const ALL_FIELDS: readonly MappingField[] = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

/** Field → column name. An empty string means "not mapped". */
export type ColumnMapping = Record<MappingField, string>;

/** Header words that suggest a field, most specific first. */
const HEADER_KEYWORDS: Readonly<Record<MappingField, readonly string[]>> = {
  date: ["date", "txn date", "transaction date", "posting date", "post date"],
  account_name: ["account", "ledger", "account name", "distribution account", "gl account"],
  debit: ["debit", "dr", "withdrawal", "money out"],
  credit: ["credit", "cr", "deposit", "money in"],
  split_amount: ["split amount", "amount", "transaction amount", "net amount", "signed amount"],
  description: ["description", "narration", "memo", "details", "remarks", "note"],
  transaction_type: ["transaction type", "type", "entry type", "journal type"],
  balance: ["balance", "running balance", "closing balance"],
  reference: ["reference", "ref", "document", "journal no", "transaction id", "voucher"],
  account_type: ["account type", "type"],
  account_number: ["account number", "acct number", "account #", "gl code"],
};

/** How good a match has to be before it is assigned at all. */
const SCORE_THRESHOLD: Readonly<Record<MappingField, number>> = {
  date: 0.48,
  account_name: 0.45,
  debit: 0.4,
  credit: 0.4,
  split_amount: 0.42,
  description: 0.28,
  transaction_type: 0.3,
  balance: 0.35,
  reference: 0.25,
  account_type: 0.35,
  account_number: 0.35,
};

/** Below this, a required field is reported as needing a human. */
export const CONFIDENCE_THRESHOLD = 0.52;

/** How many rows to look at. Enough to characterise a column, not the file. */
const SAMPLE_LIMIT = 300;

const TRANSACTION_TYPE_HINTS = new Set([
  "journal", "invoice", "bill", "payment", "deposit", "transfer", "check", "cheque",
  "expense", "credit memo", "sales receipt", "refund", "charge",
]);

const ACCOUNT_TYPE_HINTS = new Set([
  "asset", "liability", "equity", "income", "revenue", "expense", "cogs",
  "bank", "accounts receivable", "accounts payable", "fixed asset",
]);

export interface ColumnProfile {
  sampled: number;
  nonEmpty: number;
  dateRatio: number;
  numericRatio: number;
  textRatio: number;
  positiveRatio: number;
  negativeRatio: number;
  uniqueRatio: number;
  descriptionRatio: number;
  transactionTypeRatio: number;
  accountTypeRatio: number;
}

export interface MappingResult {
  mapping: ColumnMapping;
  confidence: Partial<Record<MappingField, number>>;
  sources: Partial<Record<MappingField, "manual" | "auto" | "auto-value">>;
  profiles: Record<string, ColumnProfile>;
  missingRequired: string[];
  lowConfidenceFields: string[];
  /** Safe to import without asking anybody? */
  canAutoProcess: boolean;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const normalizeKey = (value: unknown): string =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const tokenize = (value: unknown): string[] =>
  normalizeKey(value).split(" ").filter(Boolean);

/** Does this look like a date? Deliberately permissive — exports vary wildly. */
export function looksLikeDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const text = String(value ?? "").trim();
  if (!text) return false;
  // A bare number is a serial date only in a spreadsheet, and treating every
  // amount as one would make every numeric column look like a date column.
  if (/^-?\d+(\.\d+)?$/.test(text)) return false;
  if (!/[/\-.]/.test(text) && !/[a-z]/i.test(text)) return false;
  const parsed = new Date(text);
  return !Number.isNaN(parsed.getTime());
}

/** The numeric value of a cell, or null. Handles `(1,234.56)` as negative. */
export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const negated = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[()]/g, "").replace(/[$£€,\s]/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negated ? -Math.abs(parsed) : parsed;
}

const containsHint = (text: string, hints: ReadonlySet<string>): boolean => {
  const key = normalizeKey(text);
  for (const hint of hints) if (key.includes(hint)) return true;
  return false;
};

/** What the values in one column look like. */
export function profileColumn(
  rows: ReadonlyArray<Record<string, unknown>>,
  column: string,
): ColumnProfile {
  let sampled = 0;
  let nonEmpty = 0;
  let dateLike = 0;
  let numericLike = 0;
  let textLike = 0;
  let positive = 0;
  let negative = 0;
  let descriptionHints = 0;
  let typeHints = 0;
  let accountTypeHints = 0;
  const unique = new Set<string>();

  for (const row of rows) {
    if (sampled >= SAMPLE_LIMIT) break;
    sampled += 1;

    const value = row[column];
    if (value === null || value === undefined || String(value).trim() === "") continue;
    nonEmpty += 1;

    const text = String(value).trim();
    unique.add(text.toLowerCase());

    if (looksLikeDate(value)) dateLike += 1;

    const amount = parseAmount(value);
    if (amount !== null) {
      numericLike += 1;
      if (amount > 0) positive += 1;
      if (amount < 0) negative += 1;
    } else {
      textLike += 1;
      // A description is long-ish free text; a code or a type is short.
      if (text.length >= 12 && /\s/.test(text)) descriptionHints += 1;
      if (containsHint(text, TRANSACTION_TYPE_HINTS)) typeHints += 1;
      if (containsHint(text, ACCOUNT_TYPE_HINTS)) accountTypeHints += 1;
    }
  }

  // Ratios over NON-EMPTY cells, not over sampled ones: a column that is half
  // blank and half dates is a date column with gaps, not a half-hearted one.
  const of = (n: number): number => (nonEmpty === 0 ? 0 : round3(n / nonEmpty));

  return {
    sampled,
    nonEmpty,
    dateRatio: of(dateLike),
    numericRatio: of(numericLike),
    textRatio: of(textLike),
    positiveRatio: of(positive),
    negativeRatio: of(negative),
    uniqueRatio: of(unique.size),
    descriptionRatio: of(descriptionHints),
    transactionTypeRatio: of(typeHints),
    accountTypeRatio: of(accountTypeHints),
  };
}

/** How well a column's NAME suggests a field. */
export function headerScore(column: string, field: MappingField): number {
  const key = normalizeKey(column);
  if (!key) return 0;

  const tokens = tokenize(column);
  let score = 0;

  for (const phrase of HEADER_KEYWORDS[field]) {
    const keyword = normalizeKey(phrase);
    if (!keyword) continue;

    // An exact header beats a containing one, which beats a partial token
    // match — "Date" should win over "Posting Date Modified".
    if (key === keyword) {
      score = Math.max(score, 1.25);
      continue;
    }
    if (key.includes(keyword)) {
      score = Math.max(score, 1);
      continue;
    }

    const keywordTokens = tokenize(keyword);
    if (keywordTokens.length === 0) continue;
    const matched = keywordTokens.filter((t) => tokens.includes(t)).length;
    if (matched > 0) {
      score = Math.max(score, 0.55 + (matched / keywordTokens.length) * 0.35);
    }
  }
  return score;
}

/** How well a column's VALUES suit a field. */
export function valueScore(field: MappingField, profile: ColumnProfile | undefined): number {
  if (!profile) return 0;

  switch (field) {
    case "date":
      return profile.dateRatio * 1.2 + (1 - profile.numericRatio) * 0.1;
    case "account_name":
      return profile.textRatio * 0.8 + profile.uniqueRatio * 0.4 + (1 - profile.numericRatio) * 0.2;
    case "debit":
      return profile.numericRatio * 0.95 + profile.negativeRatio * 0.15;
    case "credit":
      return profile.numericRatio * 0.95 + profile.positiveRatio * 0.15;
    case "split_amount": {
      // A single signed amount column has both signs in it; a debit column
      // mostly does not.
      const bothSigns = profile.positiveRatio > 0.05 && profile.negativeRatio > 0.05 ? 0.25 : 0;
      return profile.numericRatio + bothSigns;
    }
    case "description":
      return profile.textRatio * 0.55 + profile.descriptionRatio * 0.6;
    case "transaction_type":
      return profile.textRatio * 0.35 + profile.transactionTypeRatio * 0.9;
    case "balance":
      return profile.numericRatio * 0.9;
    case "reference":
      return profile.uniqueRatio * 0.5 + profile.textRatio * 0.35;
    case "account_type":
      return profile.accountTypeRatio * 1.1 + profile.textRatio * 0.2;
    case "account_number":
      return profile.numericRatio * 0.55 + profile.uniqueRatio * 0.25;
  }
}

/** Name and values together. The header carries most of it, and should. */
export function scoreColumn(
  field: MappingField,
  column: string,
  profile: ColumnProfile | undefined,
): number {
  return round3(headerScore(column, field) * 0.65 + valueScore(field, profile) * 0.35);
}

/** Every field present, unmapped ones as "". */
export function emptyMapping(partial: Partial<ColumnMapping> = {}): ColumnMapping {
  return Object.fromEntries(
    ALL_FIELDS.map((field) => [field, partial[field] ?? ""]),
  ) as ColumnMapping;
}

/** Is a mapping usable, and does anything need a human? */
export function validateMapping(
  mapping: ColumnMapping,
  confidence: Partial<Record<MappingField, number>>,
): Pick<MappingResult, "missingRequired" | "lowConfidenceFields" | "canAutoProcess"> {
  const missingRequired: string[] = [];
  if (!mapping.date) missingRequired.push("date");
  if (!mapping.account_name) missingRequired.push("account_name");

  // Either two columns of debit and credit, or one signed amount. Both shapes
  // are common and neither is more correct.
  const hasDebitAndCredit = Boolean(mapping.debit && mapping.credit);
  const hasSplit = Boolean(mapping.split_amount);
  if (!hasDebitAndCredit && !hasSplit) missingRequired.push("debit_credit_or_split_amount");

  const low = new Set<string>();
  for (const field of ["date", "account_name"] as const) {
    if (mapping[field] && (confidence[field] ?? 0) < CONFIDENCE_THRESHOLD) low.add(field);
  }
  if (hasDebitAndCredit) {
    if ((confidence.debit ?? 0) < CONFIDENCE_THRESHOLD) low.add("debit");
    if ((confidence.credit ?? 0) < CONFIDENCE_THRESHOLD) low.add("credit");
  } else if (hasSplit) {
    if ((confidence.split_amount ?? 0) < CONFIDENCE_THRESHOLD) low.add("split_amount");
  }

  const lowConfidenceFields = [...low];
  return {
    missingRequired,
    lowConfidenceFields,
    canAutoProcess: missingRequired.length === 0 && lowConfidenceFields.length === 0,
  };
}

/**
 * Work out the mapping.
 *
 * Anything the user supplied wins outright and is never second-guessed —
 * they are looking at the file.
 */
export function detectMapping(input: {
  columns: readonly string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  mapping?: Partial<ColumnMapping>;
}): MappingResult {
  const { columns, rows } = input;
  const provided = emptyMapping(input.mapping ?? {});
  const detected = emptyMapping();
  const confidence: Partial<Record<MappingField, number>> = {};
  const sources: MappingResult["sources"] = {};
  const used = new Set<string>();

  const profiles = Object.fromEntries(
    columns.map((column) => [column, profileColumn(rows, column)]),
  );

  // The user's choices first, so auto-detection cannot take a column they
  // already assigned to something else.
  for (const field of ALL_FIELDS) {
    const choice = provided[field];
    if (choice && columns.includes(choice)) {
      detected[field] = choice;
      confidence[field] = 1;
      sources[field] = "manual";
      used.add(choice);
    }
  }

  const assign = (field: MappingField, allowReuse = false): void => {
    if (detected[field]) return;
    let bestColumn = "";
    let bestScore = -1;

    for (const column of columns) {
      if (!allowReuse && used.has(column)) continue;
      const score = scoreColumn(field, column, profiles[column]);
      if (score > bestScore) {
        bestScore = score;
        bestColumn = column;
      }
    }

    if (!bestColumn || bestScore < SCORE_THRESHOLD[field]) return;
    detected[field] = bestColumn;
    confidence[field] = Math.max(0, Math.min(1, bestScore));
    sources[field] = "auto";
    if (!allowReuse) used.add(bestColumn);
  };

  // In priority order, because assignment is greedy: "Date" should be claimed
  // by `date` before `description` can take it on a weak text score.
  for (const field of [
    "date", "account_name", "debit", "credit", "balance",
    "description", "transaction_type", "reference", "account_type", "account_number",
  ] as const) {
    assign(field);
  }

  // Split amount is an ALTERNATIVE to debit-and-credit, not a supplement.
  //
  // Legacy assigned it regardless, and allowed it to reuse an already-claimed
  // column — so a file with proper Debit and Credit columns also came back
  // with `split_amount` pointing at one of them. An importer that read both
  // would count those rows twice, and the only thing standing between that and
  // a doubled ledger was the importer preferring one over the other.
  //
  // It is only looked for when the pair is incomplete. Then it MAY reuse a
  // column, because a file with a single "Amount" column may have had it
  // claimed by `balance` and the split reading is still the right one.
  if (!detected.debit || !detected.credit) {
    assign("split_amount");
    if (!detected.split_amount) assign("split_amount", true);
  }

  // Last resort: no debit, no credit, no split, but a strongly numeric column.
  // Better a flagged guess than an import that cannot proceed at all.
  if (!detected.debit && !detected.credit && !detected.split_amount) {
    let bestColumn = "";
    let bestScore = 0;
    for (const column of columns) {
      const profile = profiles[column];
      if (!profile) continue;
      const score = round3(
        profile.numericRatio + profile.positiveRatio + profile.negativeRatio * 0.5,
      );
      if (score > bestScore) {
        bestScore = score;
        bestColumn = column;
      }
    }
    if (bestColumn && bestScore >= 0.6) {
      detected.split_amount = bestColumn;
      // Deliberately below the confidence threshold, whatever the score.
      //
      // This column was chosen because NOTHING matched — not its header, not
      // the both-signs shape a signed amount column has. Reporting that as
      // `min(1, bestScore)` gave it 1.0, the highest confidence in the system,
      // so `canAutoProcess` came back true and the import ran on a guess
      // without anybody looking at it. The comment above has always said
      // "a flagged guess"; this is what makes it one.
      confidence.split_amount = round3(CONFIDENCE_THRESHOLD - 0.01);
      sources.split_amount = "auto-value";
    }
  }

  return {
    mapping: detected,
    confidence,
    sources,
    profiles,
    ...validateMapping(detected, confidence),
  };
}
