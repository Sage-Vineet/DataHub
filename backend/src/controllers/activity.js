const db = require("../db");
const asyncHandler = require("../utils");

const listActivity = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM activity_log WHERE company_id = $1 ORDER BY created_at DESC",
    [req.params.id]
  );
  res.json(rows);
});

module.exports = { listActivity };
