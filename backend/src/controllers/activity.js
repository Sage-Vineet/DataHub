const { supabase } = require("../db");
const asyncHandler = require("../utils");

const listActivity = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("company_id", req.params.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

module.exports = { listActivity };

