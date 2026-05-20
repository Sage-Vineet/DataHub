/**
 * In-process report result cache.
 *
 * Same model as the auth user cache: a Map with TTL + max-entry cap.
 * Cache key = deterministic JSON of the filter params that produced the result.
 * Invalidation = evict all entries for a company when new GL batch is staged.
 *
 * TTL: 5 minutes (reports don't change between stagings)
 * Cap: 500 entries (~50 companies × 10 filter combos each)
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX    = 500;

const _cache = new Map();

function _key(type, companyId, filters) {
  return JSON.stringify({ type, companyId, ...filters });
}

function _isExpired(entry) {
  return Date.now() - entry.ts > CACHE_TTL_MS;
}

function _evictOldest() {
  const oldest = _cache.keys().next().value;
  if (oldest !== undefined) _cache.delete(oldest);
}

function get(type, companyId, filters) {
  const k = _key(type, companyId, filters);
  const entry = _cache.get(k);
  if (!entry) return null;
  if (_isExpired(entry)) {
    _cache.delete(k);
    return null;
  }
  return entry.data;
}

function set(type, companyId, filters, data) {
  const k = _key(type, companyId, filters);
  if (_cache.size >= CACHE_MAX) _evictOldest();
  _cache.set(k, { data, ts: Date.now() });
}

/**
 * Evict every cached entry for a company.
 * Call this immediately after a new batch is staged.
 */
function invalidateCompany(companyId) {
  const prefix = `"companyId":"${companyId}"`;
  for (const k of _cache.keys()) {
    if (k.includes(prefix)) _cache.delete(k);
  }
}

/**
 * Evict a single specific report variant.
 */
function invalidateOne(type, companyId, filters) {
  _cache.delete(_key(type, companyId, filters));
}

module.exports = { get, set, invalidateCompany, invalidateOne };
