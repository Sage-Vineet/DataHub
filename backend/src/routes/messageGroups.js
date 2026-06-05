"use strict";

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const ctrl = require("../controllers/messageGroups");

// ─── Group management ─────────────────────────────────────────────────────────
router.get("/my-groups",                                           requireAuth, ctrl.listGroupsForUser);
router.get("/companies/:companyId/message-groups",                 requireAuth, ctrl.listGroupsForCompany);
router.post("/companies/:companyId/message-groups/auto-create",    requireAuth, ctrl.triggerAutoCreate);
router.post("/message-groups/:groupId/members",                    requireAuth, ctrl.addMemberToGroup);
router.delete("/message-groups/:groupId/members/:userId",          requireAuth, ctrl.removeMemberFromGroup);

// ─── Group messages ───────────────────────────────────────────────────────────
router.get("/message-groups/:groupId/messages",                    requireAuth, ctrl.listGroupMessages);
router.post("/message-groups/:groupId/messages",                   requireAuth, ctrl.sendGroupMessage);
router.post("/message-groups/:groupId/messages/mark-read",         requireAuth, ctrl.markGroupRead);
router.get("/message-groups/:groupId/messages/unread-count",       requireAuth, ctrl.getGroupUnreadCount);

module.exports = router;
