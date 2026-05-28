require("dotenv").config();

const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

module.exports = { CLIENT_STATIC_PASSWORD };
