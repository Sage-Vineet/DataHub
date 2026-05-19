const asyncHandler = require("../utils");
const { authenticate, createBrokerAccount } = require("../services/authService");

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  try {
    const { user, token } = await authenticate(email, password);
    return res.json({ token, user });
  } catch (error) {
    if (error.message === "Invalid credentials") {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    throw error;
  }
});

const signupBroker = asyncHandler(async (req, res) => {
  const { password, confirm_password, confirmPassword } = req.body || {};
  const confirm = confirm_password ?? confirmPassword;

  if (confirm !== undefined && String(password || "") !== String(confirm || "")) {
    return res.status(400).json({ error: "Passwords do not match." });
  }

  try {
    const { user, token } = await createBrokerAccount(req.body);
    return res.status(201).json({ token, user });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
});

const logout = asyncHandler(async (req, res) => {
  return res.status(204).send();
});

const me = asyncHandler(async (req, res) => {
  return res.json({ user: req.user });
});

module.exports = { login, signupBroker, logout, me };
