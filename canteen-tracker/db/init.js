const fs = require("fs");
const path = require("path");
const pool = require("../db");

async function initSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  const client = await pool.connect();
  try {
    await client.query(sql);
    // eslint-disable-next-line no-console
    console.log("Database schema initialised successfully.");
  } catch (err) {
    // Ignore "already exists" errors so re-deploys don't crash the app.
    // PostgreSQL error code 42P07 = duplicate_table
    // PostgreSQL error code 42P06 = duplicate_schema
    if (err.code === "42P07" || err.code === "42P06") {
      // eslint-disable-next-line no-console
      console.log("Database schema already exists, skipping initialisation.");
    } else {
      // eslint-disable-next-line no-console
      console.error("Failed to initialise database schema:", err.message);
      throw err;
    }
  } finally {
    client.release();
  }
}

module.exports = initSchema;
