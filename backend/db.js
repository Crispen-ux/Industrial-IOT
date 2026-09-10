// Connection pool for Postgres (Neon or any standard Postgres server).
// Neon requires SSL; local/dev Postgres usually doesn't offer it, so SSL is
// only forced on when the connection string doesn't already specify sslmode
// and isn't obviously localhost.
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env and set it to your Neon connection string.");
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const needsSSL = !isLocal && !/sslmode=/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

pool.on("error", (err) => {
  // a lost idle connection shouldn't crash the process — the pool reconnects
  // on the next query
  console.error("[db] unexpected pool error:", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
