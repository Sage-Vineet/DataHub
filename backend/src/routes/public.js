const express = require("express");
const { listPublicUsers, getPublicUser } = require("../controllers/users");

const router = express.Router();

router.get("/public/users", listPublicUsers);
router.get("/public/users/:id", getPublicUser);

module.exports = router;
