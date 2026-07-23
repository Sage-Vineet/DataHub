// ============================================================================
// PAGED FETCH — the only safe way to read a large table from Supabase
//
// Supabase/PostgREST enforces a server-side row cap (the project's "Max Rows"
// API setting, commonly defaulted to 1000) that SILENTLY TRUNCATES any single
// query response to that ceiling — regardless of a client-side `.limit(200000)`
// hint. `.limit()` only lowers the requested count; it cannot raise it past the
// server's cap. The only way to retrieve more rows than the cap is true
// `.range()` pagination: request page after page until a page comes back
// shorter than the page size.
//
// Every read against a Key Reports entry table (general_ledger_entries,
// balance_sheet_entries, trial_balance_entries, bs_reconciliation_entries, …)
// that can plausibly exceed ~1000 rows for a single company/version/year MUST
// go through fetchAllRows — never a bare `.limit(N)` call.
// ============================================================================

"use strict";

const PAGE_SIZE = 1000;

/**
 * @param {() => import('@supabase/supabase-js').PostgrestFilterBuilder} buildQuery
 *   Closure returning a FRESH query with the same filters every call — do NOT
 *   call `.range()` or `.limit()` inside it, this helper appends `.range()`.
 * @param {{ pageSize?: number, label?: string }} [opts]
 * @returns {Promise<any[]>}
 */
async function fetchAllRows(buildQuery, opts = {}) {
  const pageSize = opts.pageSize || PAGE_SIZE;
  const out = [];
  let from = 0;
  // Backstop against a runaway loop (e.g. a query that never shrinks) — 5000
  // pages at the default page size is 5M rows, far beyond any realistic dataset.
  for (let page = 0; page < 5000; page += 1) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  if (opts.label) console.log(`[PagedFetch][${opts.label}] retrieved ${out.length} row(s)`);
  return out;
}

module.exports = { fetchAllRows, PAGE_SIZE };
