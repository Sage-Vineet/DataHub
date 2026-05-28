const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { listActivity, listBrokerActivity } = require("../controllers/activity");

const router = express.Router();

router.get("/broker/activity", requireAuth, listBrokerActivity);
router.get("/companies/:id/activity", requireAuth, listActivity);

module.exports = router;
