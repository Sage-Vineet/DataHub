const asyncHandler = require("../utils");
const { authenticate } = require("../services/authService");

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

const logout = asyncHandler(async (req, res) => {
  return res.status(204).send();
});

const me = asyncHandler(async (req, res) => {
  return res.json({ user: req.user });
});

module.exports = { login, logout, me };