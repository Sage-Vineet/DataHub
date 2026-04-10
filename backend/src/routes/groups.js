const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  addMember,
  removeMember,
  listGroupMembers,
} = require("../controllers/groups");

const router = express.Router();
router.use(requireAuth);

router.get("/companies/:id/groups", listGroups);
router.post("/companies/:id/groups", createGroup);
router.patch("/groups/:id", updateGroup);
router.delete("/groups/:id", deleteGroup);
router.post("/groups/:id/members", addMember);
router.get("/groups/:id/members", listGroupMembers);
router.delete("/groups/:id/members/:userId", removeMember);

module.exports = router;
