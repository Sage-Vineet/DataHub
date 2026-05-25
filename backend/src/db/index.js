const { 
  supabase, 
  hasSupabaseCredentials,
  isCircuitBreakerOpen,
  recordSupabaseError,
  resetSupabaseErrors,
} = require("../lib/supabaseClient");

module.exports = {
  supabase,
  pool: null,
  engine: hasSupabaseCredentials ? "supabase" : "unconfigured",
  ready: Promise.resolve(),
  isCircuitBreakerOpen,
  recordSupabaseError,
  resetSupabaseErrors,
};
