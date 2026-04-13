const express = require("express");
const { listActivity } = require("../controllers/activity");

const router = express.Router();

router.get("/companies/:id/activity", listActivity);

module.exports = router;
