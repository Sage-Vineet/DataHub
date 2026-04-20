const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listThreads,
  getConversation,
  createMessage,
  listDirectContacts,
  getDirectConversation,
  createDirectMessage,
} = require("../controllers/messages");

const router = express.Router();

router.get("/messages/threads", requireAuth, listThreads);
router.get("/companies/:id/messages", requireAuth, getConversation);
router.post("/companies/:id/messages", requireAuth, createMessage);
router.get("/companies/:id/direct-messages/contacts", requireAuth, listDirectContacts);
router.get("/companies/:id/direct-messages/:recipientId", requireAuth, getDirectConversation);
router.post("/companies/:id/direct-messages/:recipientId", requireAuth, createDirectMessage);

module.exports = router;
