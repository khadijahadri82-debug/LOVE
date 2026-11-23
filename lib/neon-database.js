const { neon } = require("@neondatabase/serverless");

function createNeonDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required.");
  }

  const sql = neon(connectionString);
  return {
    query: (text, values = []) => sql.query(text, values)
  };
}

module.exports = { createNeonDatabase };
