/**
 * Client for the QoE SDE/EBITDA bridge (`QE - 0004`), served by the
 * `@datahub/api` qoe module at `/qoe`.
 *
 * Every figure on this screen is computed server-side by
 * `@datahub/financial-engine`. Nothing in the browser derives an earnings
 * number — that is the whole point of the module. The bridge this replaced
 * pattern-matched P&L row labels here in the client and, on real engagement
 * data, swept three operating-tax accounts into income tax expense.
 */
import { request } from "../lib/api";

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function fetchBridge({ versionId, years, aggregation, dataSource } = {}, options = {}) {
  return request(
    `/qoe/bridge${query({
      version_id: versionId,
      years,
      aggregation,
      data_source: dataSource,
    })}`,
    options,
  );
}

export function listAddbacks({ versionId } = {}, options = {}) {
  return request(`/qoe/addbacks${query({ version_id: versionId })}`, options);
}

export function createAddback(payload, options = {}) {
  return request("/qoe/addbacks", { method: "POST", body: payload, ...options });
}

export function deleteAddback(id, options = {}) {
  return request(`/qoe/addbacks/${encodeURIComponent(id)}`, { method: "DELETE", ...options });
}

/** Returns an unsaved draft. Nothing is persisted until `saveCommentary`. */
export function draftCommentary(id, options = {}) {
  return request(`/qoe/addbacks/${encodeURIComponent(id)}/commentary/draft`, {
    method: "POST",
    ...options,
  });
}

export function saveCommentary(id, commentary, options = {}) {
  return request(`/qoe/addbacks/${encodeURIComponent(id)}/commentary`, {
    method: "PUT",
    body: { commentary },
    ...options,
  });
}

export function setAccountRole(versionId, accountId, ebitdaRole, options = {}) {
  return request(
    `/qoe/versions/${encodeURIComponent(versionId)}/accounts/${encodeURIComponent(accountId)}/role`,
    { method: "PUT", body: { ebitda_role: ebitdaRole }, ...options },
  );
}
