const bcrypt = require("bcrypt");
const pool = require("../db");

const SALT_ROUNDS = 12;

/**
 * Reads admin credentials from environment variables and inserts any
 * missing admin users into the admin_users table. Existing users are
 * left untouched so that manual password changes are not overwritten.
 */
async function seedAdmins() {
  const candidates = [
    {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    },
    {
      username: process.env.ADMIN_USERNAME2,
      password: process.env.ADMIN_PASSWORD2,
    },
  ].filter(({ username, password }) => username && password);

  if (candidates.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "seedAdmins: No admin credentials found in environment variables. " +
        "Set ADMIN_USERNAME/ADMIN_PASSWORD (and optionally ADMIN_USERNAME2/ADMIN_PASSWORD2)."
    );
    return;
  }

  const client = await pool.connect();
  try {
    for (const { username, password } of candidates) {
      const existing = await client.query(
        "SELECT id FROM admin_users WHERE username = $1",
        [username]
      );

      if (existing.rowCount > 0) {
        // eslint-disable-next-line no-console
        console.log(`seedAdmins: Admin user "${username}" already exists, skipping.`);
        continue;
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      await client.query(
        "INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)",
        [username, passwordHash]
      );
      // eslint-disable-next-line no-console
      console.log(`seedAdmins: Admin user "${username}" created successfully.`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("seedAdmins: Failed to seed admin users:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = seedAdmins;
