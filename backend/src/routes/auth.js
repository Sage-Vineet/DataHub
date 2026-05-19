const express = require("express");
const { login, signupBroker, logout, me } = require("../controllers/auth");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/login", login);
router.post("/broker/signup", signupBroker);
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, me);

module.exports = router;
