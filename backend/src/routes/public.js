const express = require("express");
const { listPublicUsers, getPublicUser } = require("../controllers/users");

const router = express.Router();

router.get("/users", listPublicUsers);
router.get("/users/:id", getPublicUser);

module.exports = router;
