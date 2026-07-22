// Layer 10 — Historical classification memory.
//
// Once an account has been classified — by ANY layer, including AI — it is
// recorded here so it is never reclassified again. Checked before the
// lexicon (Layer 11) and AI (Layer 12) fallbacks, so repeated runs over the
// same books never re-guess, and AI is never billed twice for the same
// account.
//
// Backed by localStorage by default (namespaced + versioned so a logic
// change can be invalidated deliberately). Pass a custom `store` to persist
// elsewhere — e.g. a backend-synced table — without touching the engine.

const CACHE_VERSION = "v1";
const STORAGE_PREFIX = "bs-normalization-cache";

function safeLocalStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    // Storage may be blocked (private browsing, SSR, sandboxed iframe) — degrade to in-memory only.
  }
  return null;
}

function storageKey(scope) {
  return `${STORAGE_PREFIX}:${CACHE_VERSION}:${scope || "default"}`;
}

function loadFromStorage(scope) {
  const storage = safeLocalStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(storageKey(scope));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistToStorage(scope, data) {
  const storage = safeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(scope), JSON.stringify(data));
  } catch {
    // Quota exceeded or storage unavailable — caching is an optimization, never a correctness dependency.
  }
}

/** Stable cache key: normalized name, plus account number when known (so two companies' unrelated "Loan" accounts don't collide once numbered). */
export function historyCacheKey(name, meta = {}) {
  const norm = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const number = meta?.accountNumber != null ? String(meta.accountNumber) : "";
  return number ? `${norm}#${number}` : norm;
}

/**
 * Creates a pluggable classification memory. `scope` namespaces entries
 * (e.g. per company/tenant) so unrelated books never share history. Pass a
 * `store` object ({ get, set, has }) to use a different persistence layer
 * (e.g. a backend-synced cache) instead of localStorage.
 */
export function createHistoryCache({ scope = "default", store = null } = {}) {
  if (store) return store;

  let data = loadFromStorage(scope);

  return {
    has(key) {
      return Object.prototype.hasOwnProperty.call(data, key);
    },
    get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    set(key, value) {
      data = { ...data, [key]: value };
      persistToStorage(scope, data);
    },
  };
}
