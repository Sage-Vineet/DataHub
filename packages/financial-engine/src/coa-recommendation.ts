/**
 * Chart of accounts — reasonableness review, the decision logic.
 *
 * Ported from `backend/src/services/keyReports/aiHierarchyRecommendationService.js`
 * on the `data_room` branch. Everything here is pure: the orchestration that
 * calls a model and a database lives behind ports in
 * `apps/api/src/modules/coa-review/`.
 *
 * ## What this layer is, and what it is not
 *
 * It runs strictly AFTER the deterministic chart of accounts has been generated
 * and validated, and it is ADVISORY ONLY:
 *
 * - It never generates the chart of accounts.
 * - It never runs classification; the deterministic result is its input.
 * - It never writes to the chart of accounts during analysis.
 * - It never touches balances, GL mappings, the trial balance, or report totals.
 * - It never auto-applies. Every proposal is stored pending, and only a person
 *   can move it to applied or rejected.
 *
 * Its job is a second-pass accounting reasonableness review: read the
 * already-authoritative hierarchy and flag accounts whose placement is
 * technically possible but reads wrong on a financial statement. The classic
 * cases are interest income presented inside operating revenue, interest
 * expense inside operating expenses, and gain/loss on disposal of fixed assets
 * presented as ordinary sales or opex.
 *
 * ## Why the model can never do damage
 *
 * Nothing free-form is ever persisted. Every field of every proposal is
 * validated here, and anything that cannot be trusted is DROPPED rather than
 * repaired — quietly fixing a malformed answer would change its meaning. The
 * target section is always chosen from the company's OWN document-driven
 * category structure; where no suitable section exists the recommendation is
 * marked `AI_REASONABLENESS` so the reviewer knows it was derived rather than
 * matched. There is no hardcoded account-name-to-section table anywhere in this
 * file, and there must never be one.
 */

export const MAX_LEVELS = 15;

/** Confidence bands the model may return, and the score each maps to. */
const CONFIDENCE_BANDS = new Set(["HIGH", "MEDIUM", "LOW"]);
const BAND_SCORE: Record<string, number> = { HIGH: 0.95, MEDIUM: 0.75, LOW: 0.5 };

const KINDS = new Set(["ROLLUP_INSERT", "HIERARCHY_MOVE", "RECLASSIFY"]);
const ACCOUNT_TYPES = new Set(["income", "cogs", "expense", "asset", "liability", "equity"]);
const STATEMENT_TYPES = new Set(["profit_loss", "balance_sheet"]);

export type RecommendationKind = "ROLLUP_INSERT" | "HIERARCHY_MOVE" | "RECLASSIFY";
export type ConfidenceBand = "HIGH" | "MEDIUM" | "LOW";
export type RecommendationSource = "DOCUMENT_MATCH" | "AI_REASONABLENESS";
export type RecommendationImpact =
  | "CLASSIFICATION"
  | "PRESENTATION"
  | "BALANCE_SHEET_SECTION"
  | "OPERATING_RESULT";

/** A raw `chart_of_accounts` row, with its 15 flattened level columns. */
export interface CoaRow {
  id: string;
  account_name?: string | null;
  adjusted_name?: string | null;
  base_account?: string | null;
  account_number?: string | null;
  system_id?: string | null;
  account_type?: string | null;
  statement_type?: string | null;
  parent_account_id?: string | null;
  metadata?: { is_group?: boolean; user_modified?: boolean } | null;
  [level: string]: unknown;
}

/** One account as the reviewer sees it. */
export interface ReviewAccount {
  id: string;
  systemId: string | null;
  accountNumber: string | null;
  name: string;
  accountType: string | null;
  statementType: string | null;
  hierarchy: string[];
  parent: string | null;
  siblings: string[];
}

/** A proposal exactly as the model returns it — untrusted. */
export interface RawProposal {
  id?: unknown;
  kind?: unknown;
  recommendedHierarchy?: unknown;
  recommendedAccountType?: unknown;
  recommendedStatementType?: unknown;
  confidence?: unknown;
  reason?: unknown;
}

/** A proposal that survived validation. */
export interface NormalizedProposal {
  accountId: string;
  kind: RecommendationKind;
  recommendedHierarchy: string[];
  recommendedRollup: string;
  recommendedParent: string | null;
  recommendedAccountType: string | null;
  recommendedStatementType: string | null;
  confidenceBand: ConfidenceBand;
  confidence: number;
  source: RecommendationSource;
  impact: RecommendationImpact;
  reason: string | null;
}

export interface SectionCatalog {
  profit_loss: string[][];
  balance_sheet: string[][];
}

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

const samePath = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean =>
  JSON.stringify((a ?? []).map(norm)) === JSON.stringify((b ?? []).map(norm));

export function displayName(row: CoaRow): string {
  return String(row.adjusted_name || row.base_account || row.account_name || "");
}

/**
 * Collapse the flattened level columns back to the account's real depth.
 *
 * The COA generator pads every level past a leaf's real depth by repeating its
 * deepest real value, so every row has a full 15-column shape. Left alone, that
 * makes every leaf look several levels deeper than it is — which corrupts both
 * what the model sees and how a recommendation is applied.
 */
export function columnsToLevels(row: CoaRow): string[] {
  const levels: (string | null)[] = [];
  for (let i = 0; i < MAX_LEVELS; i += 1) {
    levels.push((row[`level_${i + 1}`] as string | null) || null);
  }
  const nonNull = levels.filter(Boolean) as string[];
  while (nonNull.length > 1 && nonNull[nonNull.length - 1] === nonNull[nonNull.length - 2]) {
    nonNull.pop();
  }
  return nonNull;
}

/**
 * A stable identity for "the account's classification as the reviewer saw it".
 *
 * Used to detect that the chart of accounts has moved on since a recommendation
 * was generated, so a stale proposal cannot silently undo a newer edit.
 */
export function classificationFingerprint({
  hierarchy,
  accountType,
  statementType,
}: {
  hierarchy?: readonly string[] | null;
  accountType?: string | null;
  statementType?: string | null;
}): string {
  return JSON.stringify({
    h: (hierarchy ?? []).map(norm),
    t: norm(accountType),
    s: norm(statementType),
  });
}

/**
 * The company's OWN section structure, per statement, derived from the category
 * nodes the deterministic generator built from the uploaded documents.
 *
 * This is what makes a recommendation document-driven rather than hardcoded:
 * the model is told which sections actually exist and asked to choose among
 * them.
 */
export function buildSectionCatalog(categories: readonly CoaRow[]): SectionCatalog {
  const byStatement: SectionCatalog = { profit_loss: [], balance_sheet: [] };

  for (const category of categories) {
    const path = columnsToLevels(category);
    if (!path.length) continue;
    const statement = String(category.statement_type ?? "");
    if (!STATEMENT_TYPES.has(statement)) continue;
    byStatement[statement as keyof SectionCatalog].push(path);
  }

  for (const key of Object.keys(byStatement) as (keyof SectionCatalog)[]) {
    const seen = new Set<string>();
    byStatement[key] = byStatement[key]
      .filter((p) => {
        const k = p.map(norm).join(" > ");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.join(" > ").localeCompare(b.join(" > ")));
  }
  return byStatement;
}

/**
 * Accounts sharing an immediate parent.
 *
 * This is the context that distinguishes a genuinely misplaced account from one
 * whose neighbours make its placement sensible — "Gain sharing revenue" must
 * not be treated like "Gain on Sale of Assets".
 */
export function buildSiblingIndex(leaves: readonly CoaRow[]): Map<string, string[]> {
  const byParent = new Map<string, string[]>();
  for (const row of leaves) {
    const key = row.parent_account_id || "__root__";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(displayName(row));
  }
  return byParent;
}

export function toReviewInput(row: CoaRow, siblingIndex: Map<string, string[]>): ReviewAccount {
  const hierarchy = columnsToLevels(row);
  const siblings = (siblingIndex.get(row.parent_account_id || "__root__") ?? []).filter(
    (n) => n !== displayName(row),
  );
  return {
    id: row.id,
    systemId: row.system_id ?? null,
    accountNumber: row.account_number ?? null,
    name: displayName(row),
    accountType: row.account_type ?? null,
    statementType: row.statement_type ?? null,
    hierarchy,
    parent: hierarchy.length >= 2 ? hierarchy[hierarchy.length - 2]! : null,
    siblings: siblings.slice(0, 12),
  };
}

/**
 * The reasonableness prompt.
 *
 * Deliberately not the document-extraction prompt, and it never asks the model
 * to regenerate or reclassify anything. It asks one question per account: does
 * this placement read correctly on a financial statement, and if not, which of
 * THIS COMPANY'S existing sections should it move to?
 */
export function buildReasonablenessPrompt(
  batch: readonly ReviewAccount[],
  sections: readonly string[][],
  statementType: string,
): string {
  const accountLines = batch.map((a) =>
    JSON.stringify({
      id: a.id,
      systemId: a.systemId,
      accountNumber: a.accountNumber,
      accountName: a.name,
      accountType: a.accountType,
      statementType: a.statementType,
      currentHierarchy: a.hierarchy,
      immediateParent: a.parent,
      siblings: a.siblings,
    }),
  );

  const sectionLines = (sections ?? []).slice(0, 200).map((p) => `  ${p.join(" > ")}`);

  return `You are a CPA performing a REASONABLENESS REVIEW of an already-generated Chart of Accounts for one company. The classification and hierarchy you are shown were produced by a deterministic engine and are the source of truth. You are NOT being asked to regenerate, re-classify, or re-build anything.

Your ONLY job: identify accounts whose current placement is technically possible but would read INCORRECTLY on a financial statement, and say where in THIS COMPANY'S OWN existing structure they belong instead.

THE ACCOUNTING PRESENTATION PRINCIPLE you are applying (this is intent, NOT a structure to impose):
non-operating items must not be presented inside operating results. Operating revenue and operating expenses determine Operating Income; interest, investment income, and gains/losses on disposal of assets belong below it, with taxes below that, arriving at Net Income.

STRONG CANDIDATES (only when context agrees):
- Interest Income / Dividend Income / Investment Income / Rental Income presented inside operating revenue or sales
- Interest Expense / Interest Paid / Loan Interest / Finance Charges / Financing Costs presented inside operating expenses
- Gain or Loss on Sale/Disposal of Assets, Fixed Assets, Equipment or Investments presented as ordinary revenue or ordinary operating expense
- Foreign exchange gain/loss, unrealized gain/loss presented inside operating results
- Income Tax / Corporate Tax expense presented as an ordinary operating expense
- Owner distributions presented as an expense, or owner contributions presented as revenue
- Retained Earnings or another equity account presented as a P&L account
- A Balance Sheet account presented as a P&L account, or vice versa

DO NOT flag an account merely because its name contains one of those words. Judge from the whole context you are given — the account name, its number, its current hierarchy, its immediate parent, and its sibling accounts. Examples of correct restraint:
- "Gain sharing revenue" is operating revenue, NOT a gain on asset disposal. Leave it.
- "Interest-related operating revenue" at a lender is operating revenue. Leave it.
- An account already sitting under a clearly non-operating section is correctly placed. Leave it.
- A vague name such as "Other Charges" with no corroborating context is at most LOW confidence — prefer no recommendation.

THIS COMPANY'S EXISTING ${statementType === "balance_sheet" ? "BALANCE SHEET" : "PROFIT & LOSS"} SECTIONS (choose a target from these wherever one fits — do not invent a section when a suitable one exists):
${sectionLines.length ? sectionLines.join("\n") : "  (none available)"}

ACCOUNTS TO REVIEW (one JSON object per line):
${accountLines.join("\n")}

For each account you are recommending a change for, return the COMPLETE recommended hierarchy as an array of labels from the top level down to and INCLUDING the account's own name as the final element. The account's own name must be reproduced exactly as given — you are never renaming an account.

Set "kind":
  "HIERARCHY_MOVE"  the account stays the same type but belongs under a different section
  "ROLLUP_INSERT"   the account is in the right area but needs one more specific grouping label above it
  "RECLASSIFY"      the account is on the wrong statement entirely; also set recommendedAccountType and recommendedStatementType

Set "confidence" to "HIGH" only when the account name AND the surrounding context clearly conflict with the current placement. Use "MEDIUM" when the name is indicative but the context is not decisive, and "LOW" when it is a judgement call.

Return STRICT JSON only — no markdown, no prose. If nothing is worth recommending, return {"recommendations": []}.
{
  "recommendations": [
    {
      "id": "<echo the account id exactly>",
      "kind": "HIERARCHY_MOVE",
      "recommendedHierarchy": ["<top level>", "...", "<the account's own name>"],
      "recommendedAccountType": null,
      "recommendedStatementType": null,
      "confidence": "HIGH",
      "reason": "<one sentence explaining the presentation problem, in plain language for an accountant>"
    }
  ]
}`;
}

/**
 * Is the proposed parent path one of the company's real, document-driven
 * sections?
 *
 * Decided here rather than trusting the model to self-report, so `source` is
 * always accurate.
 */
export function resolveSource(
  recommendedHierarchy: readonly string[] | null | undefined,
  sectionPaths: readonly string[][] | null | undefined,
): RecommendationSource {
  const parentPath = (recommendedHierarchy ?? []).slice(0, -1);
  if (!parentPath.length) return "AI_REASONABLENESS";
  const key = parentPath.map(norm).join(" > ");
  const known = new Set((sectionPaths ?? []).map((p) => p.map(norm).join(" > ")));
  return known.has(key) ? "DOCUMENT_MATCH" : "AI_REASONABLENESS";
}

/**
 * What a change would actually move.
 *
 * Used to keep the review list to things that matter rather than hundreds of
 * cosmetic observations.
 */
export function resolveImpact(
  kind: string,
  account: ReviewAccount,
  recommendedHierarchy: readonly string[] | null | undefined,
): RecommendationImpact {
  if (kind === "RECLASSIFY") return "CLASSIFICATION";
  const before = (account.hierarchy ?? []).slice(0, -1).map(norm).join(" > ");
  const after = (recommendedHierarchy ?? []).slice(0, -1).map(norm).join(" > ");
  if (before === after) return "PRESENTATION";
  // The account moves to a different branch: this is what shifts Operating
  // Income / Other Income / EBITDA subtotals on the P&L, or which section of
  // the balance sheet a figure lands in.
  return account.statementType === "balance_sheet" ? "BALANCE_SHEET_SECTION" : "OPERATING_RESULT";
}

/**
 * Validate one model proposal against the account it claims to be about.
 *
 * Returns `null` when the proposal cannot be trusted. Every rejection below is
 * a drop rather than a repair, deliberately.
 */
export function normalizeProposal(
  raw: RawProposal | null | undefined,
  account: ReviewAccount | null | undefined,
  sectionPaths: readonly string[][] | null | undefined,
): NormalizedProposal | null {
  if (!raw || !account) return null;

  const kind = (KINDS.has(String(raw.kind ?? "").trim())
    ? String(raw.kind).trim()
    : "HIERARCHY_MOVE") as RecommendationKind;

  const band = String(raw.confidence ?? "").trim().toUpperCase();
  if (!CONFIDENCE_BANDS.has(band)) return null;

  if (!Array.isArray(raw.recommendedHierarchy)) return null;
  const hierarchy = (raw.recommendedHierarchy as unknown[]).map((s) => String(s ?? "").trim());

  // A blank level means a malformed path. Reject rather than silently compact
  // it — quietly repairing a bad answer would change its meaning.
  if (hierarchy.some((l) => !l)) return null;
  // Must be a usable path that still ends at THIS account: a recommendation is
  // never allowed to rename an account or swallow it into another.
  if (hierarchy.length < 2 || hierarchy.length > MAX_LEVELS) return null;
  if (norm(hierarchy[hierarchy.length - 1]) !== norm(account.name)) return null;
  // A no-op proposal is noise, not a recommendation.
  if (samePath(hierarchy, account.hierarchy)) return null;
  // The account can never end up inside itself.
  if (hierarchy.slice(0, -1).some((l) => norm(l) === norm(account.name))) return null;

  let recommendedAccountType: string | null = null;
  let recommendedStatementType: string | null = null;
  if (kind === "RECLASSIFY") {
    recommendedAccountType = String(raw.recommendedAccountType ?? "").trim().toLowerCase() || null;
    recommendedStatementType =
      String(raw.recommendedStatementType ?? "").trim().toLowerCase() || null;
    // A reclassification with no valid target type is meaningless — and must
    // never be silently downgraded to a hierarchy move, which would apply a P&L
    // path to a balance-sheet account.
    if (!recommendedAccountType || !ACCOUNT_TYPES.has(recommendedAccountType)) return null;
    if (recommendedStatementType && !STATEMENT_TYPES.has(recommendedStatementType)) return null;
    if (recommendedAccountType === account.accountType) return null;
  }

  return {
    accountId: account.id,
    kind,
    recommendedHierarchy: hierarchy,
    // The deepest new label, kept because the store's uniqueness key
    // (version, account, rollup) is what makes a re-run upsert onto the same
    // row instead of duplicating it.
    recommendedRollup: hierarchy[hierarchy.length - 2]!,
    recommendedParent: hierarchy.length >= 3 ? hierarchy[hierarchy.length - 3]! : null,
    recommendedAccountType,
    recommendedStatementType,
    confidenceBand: band as ConfidenceBand,
    confidence: BAND_SCORE[band]!,
    source: resolveSource(hierarchy, sectionPaths),
    impact: resolveImpact(kind, account, hierarchy),
    reason: String(raw.reason ?? "").trim() || null,
  };
}

/**
 * Keep only recommendations that can materially affect a statement.
 *
 * A LOW-confidence cosmetic regrouping is exactly the noise that makes a review
 * list unusable; a LOW-confidence RECLASSIFY is still worth a human look,
 * because it changes which statement a number appears on.
 */
export function isMaterial(p: NormalizedProposal): boolean {
  if (p.kind === "RECLASSIFY") return true;
  if (p.confidenceBand === "LOW") return false;
  return p.impact !== "PRESENTATION" || p.confidenceBand === "HIGH";
}

/**
 * The hierarchy a recommendation wants, expressed against the account's CURRENT
 * levels. Legacy `ROLLUP_INSERT` rows carry only the label to insert.
 */
export function resolveTargetLevels(
  reco: { recommended_hierarchy?: unknown; recommended_rollup?: string | null },
  currentLevels: readonly string[],
  ownName: string,
): string[] {
  if (Array.isArray(reco.recommended_hierarchy) && reco.recommended_hierarchy.length >= 2) {
    return (reco.recommended_hierarchy as string[]).slice(0, MAX_LEVELS);
  }
  const alreadyInserted =
    currentLevels.length >= 2 &&
    norm(currentLevels[currentLevels.length - 2]) === norm(reco.recommended_rollup);
  if (alreadyInserted) return [...currentLevels];
  return [...currentLevels.slice(0, -1), String(reco.recommended_rollup), ownName].slice(0, MAX_LEVELS);
}

/**
 * Structural safety checks that must hold before anything is written.
 *
 * Deliberately about the SHAPE of the change. This layer changes presentation
 * and classification, never a GL amount, so no balance can move as a direct
 * result of applying one of these.
 */
export function validateTargetLevels(
  levels: readonly string[] | null | undefined,
  ownName: string,
): string[] {
  const problems: string[] = [];
  if (!Array.isArray(levels) || levels.length < 2) {
    problems.push("The recommended hierarchy is not a usable path.");
    return problems;
  }
  if (levels.length > MAX_LEVELS) {
    problems.push(`The recommended hierarchy exceeds the maximum of ${MAX_LEVELS} levels.`);
  }
  if (levels.some((l) => !String(l ?? "").trim())) {
    problems.push("The recommended hierarchy contains an empty level.");
  }
  if (norm(levels[levels.length - 1]) !== norm(ownName)) {
    problems.push(
      "The recommended hierarchy does not end at this account — a recommendation can never rename or absorb an account.",
    );
  }
  if (levels.slice(0, -1).some((l) => norm(l) === norm(ownName))) {
    problems.push("The recommended hierarchy would place the account inside itself.");
  }
  return problems;
}

/**
 * Statuses are stored lowercase (the original engine's convention, preserved so
 * already-decided rows stay valid) and exposed uppercase, which is the contract
 * the review UI speaks.
 */
const PUBLIC_STATUS: Record<string, string> = {
  pending: "PENDING",
  applied: "APPLIED",
  rejected: "REJECTED",
  accepted: "APPLIED", // legacy: the original engine applied on accept
  ignored: "REJECTED", // legacy
};

/** A stored recommendation row, as the repository returns it. */
export interface StoredRecommendation {
  id: string;
  account_id: string;
  current_hierarchy?: string[] | null;
  current_account_type?: string | null;
  current_statement_type?: string | null;
  kind?: string | null;
  recommended_hierarchy?: string[] | null;
  recommended_rollup?: string | null;
  recommended_parent?: string | null;
  recommended_account_type?: string | null;
  recommended_statement_type?: string | null;
  confidence?: number | null;
  confidence_band?: string | null;
  source?: string | null;
  impact?: string | null;
  reason?: string | null;
  status?: string | null;
  rejection_reason?: string | null;
  ai_model?: string | null;
  created_at?: string | null;
  decided_at?: string | null;
  decided_by?: string | null;
  applied_at?: string | null;
  /** Joined account columns, when the repository includes them. */
  chart_of_accounts?: {
    account_name?: string | null;
    adjusted_name?: string | null;
    base_account?: string | null;
    system_id?: string | null;
    account_number?: string | null;
  } | null;
}

export function toPublicRecommendation(r: StoredRecommendation): Record<string, unknown> {
  const currentHierarchy = r.current_hierarchy ?? [];
  // Rows written by the original engine stored only the inserted label; derive
  // the equivalent full path so one UI can render both generations of row.
  const recommendedHierarchy =
    r.recommended_hierarchy ??
    (r.recommended_rollup && currentHierarchy.length
      ? [
          ...currentHierarchy.slice(0, -1),
          r.recommended_rollup,
          currentHierarchy[currentHierarchy.length - 1]!,
        ]
      : null);

  return {
    id: r.id,
    recommendationId: r.id,
    accountId: r.account_id,
    accountName:
      r.chart_of_accounts?.adjusted_name ||
      r.chart_of_accounts?.base_account ||
      r.chart_of_accounts?.account_name,
    systemId: r.chart_of_accounts?.system_id ?? null,
    accountNumber: r.chart_of_accounts?.account_number ?? null,
    kind: r.kind || "ROLLUP_INSERT",
    currentStatementType: r.current_statement_type ?? null,
    currentAccountType: r.current_account_type ?? null,
    currentHierarchy,
    recommendedHierarchy,
    recommendedAccountType: r.recommended_account_type ?? null,
    recommendedStatementType: r.recommended_statement_type ?? null,
    // Retained so the existing inline badge keeps working unchanged.
    recommendedRollup: r.recommended_rollup,
    recommendedParent: r.recommended_parent,
    confidence: r.confidence,
    confidenceBand:
      r.confidence_band ||
      ((r.confidence ?? 0) >= 0.85 ? "HIGH" : (r.confidence ?? 0) >= 0.7 ? "MEDIUM" : "LOW"),
    source: r.source ?? null,
    impact: r.impact ?? null,
    reason: r.reason,
    status: PUBLIC_STATUS[String(r.status ?? "")] || String(r.status ?? "").toUpperCase(),
    rejectionReason: r.rejection_reason ?? null,
    aiModel: r.ai_model ?? null,
    generatedAt: r.created_at ?? null,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by ?? null,
    appliedAt: r.applied_at ?? null,
  };
}

/** Exposed so the service and its tests agree on the vocabulary. */
export const RECOMMENDATION_ACCOUNT_TYPES = ACCOUNT_TYPES;
export const RECOMMENDATION_STATEMENT_TYPES = STATEMENT_TYPES;
export { norm as normalizeLabel, samePath as isSamePath };
