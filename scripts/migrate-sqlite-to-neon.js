const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATION_VERSION = "001_initial";

async function applySchema(client, schemaPath) {
  const statements = fs.readFileSync(schemaPath, "utf8")
    .split(";")
    .map(statement => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await client.query(statement);
  }
  await client.query(
    "INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
    [MIGRATION_VERSION, new Date().toISOString()]
  );
}

function readSqliteData(sqlitePath) {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    sqlite.exec("BEGIN");
    const data = {
      users: sqlite.prepare("SELECT id, username, display_name, password_salt, password_hash, created_at FROM users ORDER BY id").all(),
      conversations: sqlite.prepare("SELECT id, created_at FROM conversations ORDER BY id").all(),
      conversation_members: sqlite.prepare("SELECT conversation_id, user_id FROM conversation_members ORDER BY conversation_id, user_id").all(),
      messages: sqlite.prepare("SELECT id, conversation_id, sender_id, body, created_at FROM messages ORDER BY id").all(),
      message_reads: sqlite.prepare("SELECT message_id, user_id, read_at FROM message_reads ORDER BY message_id, user_id").all(),
      sessions: sqlite.prepare("SELECT session_hash, user_id, csrf_token, expires_at FROM sessions ORDER BY session_hash").all()
    };
    sqlite.exec("COMMIT");
    return data;
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    sqlite.close();
  }
}

async function migrateSqliteToNeon({ sqlitePath, client, schemaPath = path.join(__dirname, "..", "migrations", "001_initial.sql") }) {
  const source = path.resolve(sqlitePath);
  if (!fs.existsSync(source)) {
    throw new Error("The source SQLite database file does not exist.");
  }
  if (!client || typeof client.query !== "function") {
    throw new Error("A connected PostgreSQL client is required.");
  }

  await applySchema(client, schemaPath);
  const existing = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM conversations) AS conversations,
      (SELECT COUNT(*) FROM conversation_members) AS conversation_members,
      (SELECT COUNT(*) FROM messages) AS messages,
      (SELECT COUNT(*) FROM message_reads) AS message_reads,
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM login_attempts) AS login_attempts
  `);
  if (Object.values(existing.rows[0]).some(count => Number(count) > 0)) {
    throw new Error("The target database is not empty; refusing to overwrite or merge existing data.");
  }

  const data = readSqliteData(source);
  await client.query("BEGIN");
  try {
    for (const row of data.users) {
      await client.query(
        "INSERT INTO users (id, username, display_name, password_salt, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [row.id, row.username, row.display_name, Buffer.from(row.password_salt), Buffer.from(row.password_hash), row.created_at]
      );
    }
    for (const row of data.conversations) {
      await client.query(
        "INSERT INTO conversations (id, created_at) VALUES ($1, $2)",
        [row.id, row.created_at]
      );
    }
    for (const row of data.conversation_members) {
      await client.query(
        "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)",
        [row.conversation_id, row.user_id]
      );
    }
    for (const row of data.messages) {
      await client.query(
        "INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES ($1, $2, $3, $4, $5)",
        [row.id, row.conversation_id, row.sender_id, row.body, row.created_at]
      );
    }
    for (const row of data.message_reads) {
      await client.query(
        "INSERT INTO message_reads (message_id, user_id, read_at) VALUES ($1, $2, $3)",
        [row.message_id, row.user_id, row.read_at]
      );
    }
    for (const row of data.sessions) {
      await client.query(
        "INSERT INTO sessions (session_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)",
        [row.session_hash, row.user_id, row.csrf_token, row.expires_at]
      );
    }
    await client.query(`
      SELECT setval(pg_get_serial_sequence('users', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0)
      FROM users
    `);
    await client.query(`
      SELECT setval(pg_get_serial_sequence('messages', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0)
      FROM messages
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length]));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL in your private environment before running the migration.");
  }
  const sqlitePath = process.argv[2] || path.join(__dirname, "..", "data", "chat.sqlite");
  const { Pool } = require("@neondatabase/serverless");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const counts = await migrateSqliteToNeon({ sqlitePath, client });
      console.log("SQLite data copied to Neon without modifying the source:", counts);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error("SQLite-to-Neon migration failed:", error.code || error.name || "Error");
    process.exitCode = 1;
  });
}

module.exports = { applySchema, migrateSqliteToNeon };
