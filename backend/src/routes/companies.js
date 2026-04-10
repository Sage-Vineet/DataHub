const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  listCompanies,
  createCompany,
  getCompany,
  updateCompany,
} = require("../controllers/companies");

const router = express.Router();

// Test endpoint without auth
router.get("/test", (req, res) => {
  res.json({ message: "Test endpoint works" });
});

router.use(requireAuth);

router.get("/", listCompanies);
router.post("/", createCompany);
router.get("/:id", getCompany);
router.patch("/:id", updateCompany);

module.exports = router;
