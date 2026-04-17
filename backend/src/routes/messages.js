const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listThreads,
  getConversation,
  createMessage,
} = require("../controllers/messages");

const router = express.Router();

router.get("/messages/threads", requireAuth, listThreads);
router.get("/companies/:id/messages", requireAuth, getConversation);
router.post("/companies/:id/messages", requireAuth, createMessage);

module.exports = router;
