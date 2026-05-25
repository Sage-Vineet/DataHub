const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase credentials missing or SUPABASE_SERVICE_ROLE_KEY is not set. Falling back to ANON key which will fail RLS policies.");
}

const hasSupabaseCredentials = !!(supabaseUrl && (supabaseKey || process.env.SUPABASE_ANON_KEY));

// Circuit breaker for Supabase connection issues
let isSupabaseCircuitOpen = false;
let circuitOpenUntil = 0;
const CIRCUIT_BREAKER_DURATION_MS = 30000; // 30 seconds
const CIRCUIT_BREAKER_THRESHOLD = 3; // Fail after 3 consecutive errors
let consecutiveErrors = 0;

function isCircuitBreakerOpen() {
  if (Date.now() >= circuitOpenUntil) {
    isSupabaseCircuitOpen = false;
    consecutiveErrors = 0;
  }
  return isSupabaseCircuitOpen;
}

function openCircuitBreaker() {
  isSupabaseCircuitOpen = true;
  circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_DURATION_MS;
  consecutiveErrors = 0;
  console.warn("[Supabase] Circuit breaker OPEN for 30s due to repeated connection failures");
}

function recordSupabaseError() {
  consecutiveErrors++;
  if (consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
    openCircuitBreaker();
  }
}

function resetSupabaseErrors() {
  consecutiveErrors = 0;
}

const supabase = hasSupabaseCredentials
  ? createClient(supabaseUrl, supabaseKey || process.env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
    },
    // Add global request timeout (in milliseconds)
    global: {
      fetch: (url, options = {}) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 300 second timeout (5 minutes)

        return fetch(url, {
          ...options,
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
      },
    },
  })
  : null;

if (hasSupabaseCredentials) {
  console.log("Supabase client initialized with connection timeout: 30s, circuit breaker: 30s");
}

module.exports = {
  supabase,
  hasSupabaseCredentials,
  supabaseUrl,
  isCircuitBreakerOpen,
  recordSupabaseError,
  resetSupabaseErrors,
  openCircuitBreaker,
};
