const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listUsers,
  createUser,
  getUser,
  updateUser,
  deleteUser,
  findByEmail,
  addUserToCompanies,
  removeUserFromCompanies,
  inviteBrokerToTeam,
  removeBrokerFromTeam,
} = require("../controllers/users");

const router = express.Router();

router.use(requireAuth);

router.get("/", listUsers);
router.post("/", createUser);

// Static named routes must come before /:id to avoid being matched as a user ID
router.get("/find-by-email", findByEmail);
router.post("/broker-team/invite", inviteBrokerToTeam);
router.delete("/broker-team/invite/:invitedBrokerId", removeBrokerFromTeam);

router.get("/:id", getUser);
router.patch("/:id", updateUser);
router.delete("/:id", deleteUser);
router.post("/:id/add-companies", addUserToCompanies);
router.delete("/:id/remove-companies", removeUserFromCompanies);

module.exports = router;
