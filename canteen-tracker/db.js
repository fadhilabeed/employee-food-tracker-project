const { Pool } = require("pg");
require("dotenv").config();

const APP_TIME_ZONE = process.env.APP_TIMEZONE || "Asia/Jakarta";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: `-c timezone=${APP_TIME_ZONE}`
});

module.exports = pool;
