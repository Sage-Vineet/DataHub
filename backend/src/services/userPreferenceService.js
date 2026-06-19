// Per-user UI preferences (e.g. one-time educational popups). Backed by the
// user_preferences table (unique on user_id + pref_key).

const { supabase } = require("../db");

async function getPreference(userId, prefKey) {
  if (!userId || !prefKey) return null;
  const { data, error } = await supabase
    .from("user_preferences")
    .select("pref_value")
    .eq("user_id", userId)
    .eq("pref_key", prefKey)
    .maybeSingle();
  if (error) throw error;
  return data ? data.pref_value : null;
}

async function setPreference(userId, prefKey, prefValue) {
  if (!userId || !prefKey) throw new Error("userId and prefKey are required.");
  const { data, error } = await supabase
    .from("user_preferences")
    .upsert(
      {
        user_id: userId,
        pref_key: prefKey,
        pref_value: prefValue ?? {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,pref_key" }
    )
    .select("pref_value")
    .single();
  if (error) throw error;
  return data.pref_value;
}

module.exports = { getPreference, setPreference };
