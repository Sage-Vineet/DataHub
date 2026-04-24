const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { listActivity } = require("../controllers/activity");

const router = express.Router();

router.get("/companies/:id/activity", requireAuth, listActivity);

module.exports = router;
