"use strict";

const { supabase } = require("../db");

/**
 * Saves (or replaces) the QB Online bank reconciliation snapshot for a company.
 * Uses UPSERT on company_id so there is always exactly one active snapshot per company.
 *
 * @param {object} params
 * @param {string} params.companyId        UUID of the company
 * @param {string|null} params.fetchedBy   UUID of the user who triggered the fetch
 * @param {string} params.accountingMethod "Accrual" | "Cash"
 * @param {string} params.startDate        "YYYY-MM-DD"
 * @param {string} params.endDate          "YYYY-MM-DD"
 * @param {object} params.data             Full /qb-bank-activity response payload
 */
async function saveSnapshot({ companyId, fetchedBy, accountingMethod, startDate, endDate, data }) {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("qb_bank_reconciliation_snapshots")
    .upsert(
      {
        company_id:        companyId,
        fetched_by:        fetchedBy || null,
        accounting_method: accountingMethod || "Accrual",
        start_date:        startDate,
        end_date:          endDate,
        data,
        updated_at:        now,
      },
      { onConflict: "company_id" }
    );

  if (error) throw error;

  console.log(
    `[Bank Recon] Snapshot saved — company=${companyId} range=${startDate}→${endDate} method=${accountingMethod} by=${fetchedBy || "unknown"} at=${now}`
  );
  return { saved: true };
}

/**
 * Loads the latest QB Online bank reconciliation snapshot for a company.
 * Returns null if no snapshot exists yet.
 *
 * @param {string} companyId
 * @returns {Promise<object|null>}
 */
async function loadSnapshot(companyId) {
  const { data, error } = await supabase
    .from("qb_bank_reconciliation_snapshots")
    .select("*")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;
  return data || null;
}

module.exports = { saveSnapshot, loadSnapshot };
