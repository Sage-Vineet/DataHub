const { supabase, hasSupabaseCredentials } = require("../lib/supabaseClient");

module.exports = {
  supabase,
  pool: null,
  engine: hasSupabaseCredentials ? "supabase" : "unconfigured",
  ready: Promise.resolve(),
};
