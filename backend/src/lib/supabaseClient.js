const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const hasSupabaseCredentials = Boolean(supabaseUrl && supabaseKey);

if (!hasSupabaseCredentials) {
  console.warn("Supabase credentials missing in environment variables. Starting backend without Supabase.");
}

function createUnavailableResponse() {
  const error = new Error(
    "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).",
  );
  return Promise.resolve({ data: null, error });
}

function createUnavailableQueryBuilder() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve) => resolve({
            data: null,
            error: new Error(
              "Database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).",
            ),
          });
        }
        return () => createUnavailableQueryBuilder();
      },
    },
  );
}

const unavailableSupabase = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "from" || prop === "rpc" || prop === "schema") {
        return () => createUnavailableQueryBuilder();
      }

      if (prop === "auth" || prop === "storage" || prop === "functions") {
        return new Proxy(
          {},
          {
            get() {
              return () => createUnavailableResponse();
            },
          },
        );
      }

      return undefined;
    },
  },
);

const supabase = hasSupabaseCredentials
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
      },
    })
  : unavailableSupabase;

if (hasSupabaseCredentials) {
  console.log("Supabase client initialized");
}

module.exports = { supabase, hasSupabaseCredentials };
