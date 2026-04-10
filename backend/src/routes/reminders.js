const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listReminders,
  createReminder,
  updateReminder,
  deleteReminder,
} = require("../controllers/reminders");

const router = express.Router();
router.use(requireAuth);

router.get("/companies/:id/reminders", listReminders);
router.post("/companies/:id/reminders", createReminder);
router.patch("/reminders/:id", updateReminder);
router.delete("/reminders/:id", deleteReminder);

module.exports = router;
