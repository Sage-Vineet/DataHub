const express = require("express");
const {
  login,
  signupBroker,
  logout,
  me,
  sendVerificationOtp,
  verifyVerificationOtp,
  forgotPassword,
  verifyResetOtp,
  resetPassword,
} = require("../controllers/auth");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.post("/login",                    login);
router.post("/broker/signup",            signupBroker);
router.post("/logout",                   requireAuth, logout);
router.get("/me",                        requireAuth, me);
router.post("/send-verification-otp",    sendVerificationOtp);
router.post("/verify-verification-otp",  verifyVerificationOtp);
router.post("/forgot-password",          forgotPassword);
router.post("/verify-reset-otp",         verifyResetOtp);
router.post("/reset-password",           resetPassword);

module.exports = router;
