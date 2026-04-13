const express = require("express");
const {
  listReminders,
  createReminder,
  updateReminder,
  deleteReminder,
} = require("../controllers/reminders");

const router = express.Router();

router.get("/companies/:id/reminders", listReminders);
router.post("/companies/:id/reminders", createReminder);
router.patch("/reminders/:id", updateReminder);
router.delete("/reminders/:id", deleteReminder);

module.exports = router;
