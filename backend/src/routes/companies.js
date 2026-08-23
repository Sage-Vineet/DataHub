const express = require("express");
const {
  listCompanies,
  createCompany,
  getCompany,
  updateCompany,
  deleteCompany,
} = require("../controllers/companies");

const { requireAuth } = require("../middleware/auth");
const router = express.Router();

router.use(requireAuth);

router.get("/", listCompanies);
router.post("/", createCompany);
router.get("/:id", getCompany);
router.patch("/:id", updateCompany);
router.delete("/:id", deleteCompany);

module.exports = router;
