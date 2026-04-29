const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase credentials missing or SUPABASE_SERVICE_ROLE_KEY is not set. Falling back to ANON key which will fail RLS policies.");
}

const supabase = createClient(supabaseUrl, supabaseKey || process.env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
  },
});

console.log("⚡ Supabase Client Initialized");

module.exports = { supabase };
