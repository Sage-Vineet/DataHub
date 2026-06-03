const express = require("express");
const {
  login,
  signupBroker,
  logout,
  me,
  sendVerificationOtp,
  verifyVerificationOtp,
} = require("../controllers/auth");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/login",                    login);
router.post("/broker/signup",            signupBroker);
router.post("/logout",                   requireAuth, logout);
router.get("/me",                        requireAuth, me);
router.post("/send-verification-otp",    sendVerificationOtp);
router.post("/verify-verification-otp",  verifyVerificationOtp);

module.exports = router;
