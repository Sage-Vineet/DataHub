const express = require("express");
const { listPublicUsers, getPublicUser } = require("../controllers/users");
const { hasSupabaseCredentials, supabaseUrl } = require("../lib/supabaseClient");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/health/db", (_req, res) => {
  res.json({
    engine: hasSupabaseCredentials ? "supabase" : "unconfigured",
    configured: hasSupabaseCredentials,
    projectUrl: supabaseUrl || null,
  });
});

router.get("/users", requireAuth, listPublicUsers);
router.get("/users/:id", requireAuth, getPublicUser);

module.exports = router;
