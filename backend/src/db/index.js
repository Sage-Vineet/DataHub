const { supabase, hasSupabaseCredentials } = require("../lib/supabaseClient");

module.exports = {
  supabase,
  engine: hasSupabaseCredentials ? "supabase" : "unconfigured",
  ready: Promise.resolve(),
};
