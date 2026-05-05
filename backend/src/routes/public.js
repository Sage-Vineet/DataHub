const express = require("express");
const { listPublicUsers, getPublicUser } = require("../controllers/users");
const { hasSupabaseCredentials, supabaseUrl } = require("../lib/supabaseClient");

const router = express.Router();

router.get("/health/db", (_req, res) => {
  res.json({
    engine: hasSupabaseCredentials ? "supabase" : "unconfigured",
    configured: hasSupabaseCredentials,
    projectUrl: supabaseUrl || null,
  });
});

router.get("/users", listPublicUsers);
router.get("/users/:id", getPublicUser);

module.exports = router;
