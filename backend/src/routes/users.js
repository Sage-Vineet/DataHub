const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listUsers,
  createUser,
  getUser,
  updateUser,
  deleteUser,
} = require("../controllers/users");

const router = express.Router();

router.get("/", listUsers);
router.post("/", createUser);
router.get("/:id", getUser);
router.patch("/:id", updateUser);
router.delete("/:id", requireAuth, deleteUser);

module.exports = router;
