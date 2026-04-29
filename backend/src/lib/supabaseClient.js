const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase credentials missing or SUPABASE_SERVICE_ROLE_KEY is not set. Falling back to ANON key which will fail RLS policies.");
}

const hasSupabaseCredentials = !!(supabaseUrl && (supabaseKey || process.env.SUPABASE_ANON_KEY));

const supabase = hasSupabaseCredentials
  ? createClient(supabaseUrl, supabaseKey || process.env.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
    })
  : null;

if (hasSupabaseCredentials) {
  console.log("Supabase client initialized");
}

module.exports = { supabase, hasSupabaseCredentials, supabaseUrl };
