const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { listActivity } = require("../controllers/activity");

const router = express.Router();
router.use(requireAuth);

router.get("/:id/activity", listActivity);

module.exports = router;
