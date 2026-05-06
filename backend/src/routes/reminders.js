const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listReminders,
  createReminder,
  updateReminder,
  deleteReminder,
} = require("../controllers/reminders");

const router = express.Router();

router.get("/companies/:id/reminders", requireAuth, listReminders);
router.post("/companies/:id/reminders", requireAuth, createReminder);
router.patch("/reminders/:id", requireAuth, updateReminder);
router.delete("/reminders/:id", requireAuth, deleteReminder);

module.exports = router;
