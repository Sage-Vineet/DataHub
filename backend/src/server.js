require("dotenv").config();
const app = require("./app");
const db = require("./db");

const port = process.env.PORT || 4000;

(async () => {
  try {
    await db.ready;
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Leo backend running on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start backend:", error.message);
    process.exit(1);
  }
})();
