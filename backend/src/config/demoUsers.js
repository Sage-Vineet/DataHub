require("dotenv").config();

const CLIENT_STATIC_PASSWORD = process.env.CLIENT_STATIC_PASSWORD || "123456";

const DEMO_USERS = [
  { email: "broker@leo.com",     password: "broker123" },
  { email: "admin@datahub.com",  password: "admin123"  },
  { email: "admin@leo.com",      password: "admin123"  },
  { email: "demo@leo.com",       password: "123456"    },
  { email: "client@infosys.com", password: CLIENT_STATIC_PASSWORD },
];

module.exports = { DEMO_USERS, CLIENT_STATIC_PASSWORD };
