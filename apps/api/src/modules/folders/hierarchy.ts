/** A node in the default folder hierarchy (data, not code — design D2). */
export interface FolderSpec {
  name: string;
  children?: FolderSpec[];
}

/**
 * The standard folder set every company gets, expressed as data. Provisioning
 * walks this tree and inserts each node idempotently (unique index +
 * onConflictDoNothing), so it is safe under concurrency without the legacy mutex.
 * Parity with legacy `DEFAULT_FOLDERS`: seven top-level folders plus the two
 * manual-source trees (each: Reports → BS/P&L/Cashflow, Bank Statement, Tax Return).
 */
export const DEFAULT_HIERARCHY: readonly FolderSpec[] = [
  { name: "Finance" },
  { name: "Compliance" },
  { name: "HR" },
  { name: "Legal" },
  { name: "M&A" },
  { name: "Tax" },
  { name: "Other" },
  {
    name: "Manual Upload Source",
    children: [
      { name: "Reports", children: [{ name: "Balance Sheet" }, { name: "Profit & Loss" }, { name: "Cashflow" }] },
      { name: "Bank Statement" },
      { name: "Tax Return" },
    ],
  },
  {
    name: "Quickbooks Manual Source",
    children: [
      { name: "Reports", children: [{ name: "Balance Sheet" }, { name: "Profit & Loss" }, { name: "Cashflow" }] },
      { name: "Bank Statement" },
      { name: "Tax Return" },
    ],
  },
];

/** Total node count of the default hierarchy — used for the self-heal threshold. */
export function countHierarchy(specs: readonly FolderSpec[] = DEFAULT_HIERARCHY): number {
  return specs.reduce((n, s) => n + 1 + countHierarchy(s.children ?? []), 0);
}

export const EXPECTED_FOLDER_COUNT = countHierarchy();
