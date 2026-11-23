const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { PGlite } = require("@electric-sql/pglite");
const { createServer } = require("./server");
const { migrateSqliteToNeon } = require("./scripts/migrate-sqlite-to-neon");
const vercelApi = require("./lib/vercel-api");

const ACCESS_CODE = "test-private-route-code";
const ACCESS_TOKENS = ["a".repeat(64), "b".repeat(64)];
const PARTICIPANTS = [
  { username: "alice", password: "alice-test-password-2026", displayName: "Alice" },
  { username: "bob", password: "bob-test-password-2026!!", displayName: "Bob" }
];

test("Vercel API adapter reports missing DATABASE_URL without exposing configuration", async () => {
  const envNames = [
    "DATABASE_URL",
    "CHAT_SESSION_SECRET",
    "CHAT_ACCESS_CODE",
    "CHAT_TOKEN_1",
    "CHAT_TOKEN_2",
    "CHAT_USER_1",
    "CHAT_USER_2"
  ];
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const previousConsoleError = console.error;
  const log = [];
  for (const name of envNames) delete process.env[name];
  process.env.CHAT_SESSION_SECRET = "test-session-secret-that-is-long-enough";
  process.env.CHAT_ACCESS_CODE = "test-access-code";
  process.env.CHAT_TOKEN_1 = "a".repeat(64);
  process.env.CHAT_TOKEN_2 = "b".repeat(64);
  process.env.CHAT_USER_1 = "alice";
  process.env.CHAT_USER_2 = "bob";
  console.error = (...args) => log.push(args.join(" "));

  const response = {
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
    }
  };

  try {
    await vercelApi({ url: "/api/login", method: "POST", headers: {} }, response);
    assert.equal(response.status, 503);
    assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(typeof JSON.parse(response.body).error, "string");
    assert.match(log.join(" "), /DATABASE_URL is not configured/);
    assert.doesNotMatch(response.body + log.join(" "), /postgres(?:ql)?:\/\//i);
  } finally {
    console.error = previousConsoleError;
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

function createConfig() {
  return {
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    accessCode: ACCESS_CODE,
    accessTokens: ACCESS_TOKENS,
    participants: PARTICIPANTS.map(({ username }) => ({ username }))
  };
}

async function createPostgresDatabase({ seedUsers = true } = {}) {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(__dirname, "migrations", "001_initial.sql"), "utf8"));
  const database = {
    query: async (sql, values = []) => (await pg.query(sql, values)).rows
  };

  if (seedUsers) {
    const userIds = [];
    for (const participant of PARTICIPANTS) {
      const salt = crypto.randomBytes(16);
      const passwordHash = crypto.scryptSync(participant.password, salt, 64);
      const rows = await database.query(`
        INSERT INTO users (username, display_name, password_salt, password_hash, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [participant.username, participant.displayName, salt, passwordHash, new Date().toISOString()]);
      userIds.push(rows[0].id);
    }
    await database.query("INSERT INTO conversations (id, created_at) VALUES (1, $1)", [new Date().toISOString()]);
    for (const userId of userIds) {
      await database.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES (1, $1)", [userId]);
    }
  }

  return { pg, database };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

test("Neon-backed chat routes preserve auth, messages, history, and static site", async t => {
  const { pg, database } = await createPostgresDatabase();
  t.after(() => pg.close());
  const server = createServer({ ...createConfig(), database });
  const baseUrl = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  assert.equal((await fetch(`${baseUrl}/api/messages`)).status, 401);

  const validRoute = await postJson(`${baseUrl}/api/private-route`, { code: ` ${ACCESS_CODE} ` });
  assert.deepEqual(await validRoute.json(), { openChat: true });
  assert.equal(validRoute.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${baseUrl}/api/messages`)).status, 401);

  const aliceRoute = await postJson(`${baseUrl}/api/private-route`, { code: ` ${ACCESS_TOKENS[0]} ` });
  assert.deepEqual(await aliceRoute.json(), { openChat: true });
  const aliceCookie = aliceRoute.headers.get("set-cookie")?.split(";")[0];
  assert.match(aliceRoute.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const aliceSession = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: aliceCookie } }).then(response => response.json());
  assert.equal(aliceSession.authenticated, true);
  assert.equal(aliceSession.user.displayName, "Alice");
  assert.equal(aliceSession.peer.displayName, "Bob");

  const bobRoute = await postJson(`${baseUrl}/api/private-route`, { code: ACCESS_TOKENS[1] });
  const bobCookie = bobRoute.headers.get("set-cookie")?.split(";")[0];
  const bobSession = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: bobCookie } }).then(response => response.json());
  assert.equal(bobSession.authenticated, true);
  assert.equal(bobSession.user.displayName, "Bob");
  assert.equal((await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: bobCookie } })).status, 200);

  const badToken = await postJson(`${baseUrl}/api/private-route`, { code: "c".repeat(64) });
  assert.deepEqual(await badToken.json(), { openChat: false });
  assert.equal(badToken.headers.get("set-cookie"), null);

  const wrongCode = await postJson(`${baseUrl}/api/login`, {
    username: "alice",
    password: PARTICIPANTS[0].password,
    accessCode: "incorrect-code"
  });
  assert.equal(wrongCode.status, 401);
  const wrongPassword = await postJson(`${baseUrl}/api/login`, {
    username: "alice",
    password: "incorrect-password",
    accessCode: ACCESS_CODE
  });
  assert.equal(wrongPassword.status, 401);
  for (const participant of PARTICIPANTS) {
    const validLogin = await postJson(`${baseUrl}/api/login`, {
      username: participant.username,
      password: participant.password,
      accessCode: ACCESS_CODE
    });
    assert.equal(validLogin.status, 200);
    assert.deepEqual(await validLogin.json(), { ok: true });
    assert.match(validLogin.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const loginCookie = validLogin.headers.get("set-cookie")?.split(";")[0];
    const loginSession = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: loginCookie } }).then(response => response.json());
    assert.equal(loginSession.authenticated, true);
    assert.equal(loginSession.user.displayName, participant.displayName);
  }

  const extraSalt = crypto.randomBytes(16);
  const extraPassword = "unconfigured-test-password";
  const extraHash = crypto.scryptSync(extraPassword, extraSalt, 64);
  const extraUser = await database.query(`
    INSERT INTO users (username, display_name, password_salt, password_hash, created_at)
    VALUES ('extra-user', 'Extra User', $1, $2, $3)
    RETURNING id
  `, [extraSalt, extraHash, new Date().toISOString()]);
  await database.query(
    "INSERT INTO conversation_members (conversation_id, user_id) VALUES (1, $1)",
    [extraUser[0].id]
  );
  const extraLogin = await postJson(`${baseUrl}/api/login`, {
    username: "extra-user",
    password: extraPassword,
    accessCode: ACCESS_CODE
  });
  assert.equal(extraLogin.status, 401);
  assert.equal(extraLogin.headers.get("set-cookie"), null);

  const csrfMissing = await postJson(`${baseUrl}/api/messages`, { body: "missing CSRF" }, { Cookie: aliceCookie });
  assert.equal(csrfMissing.status, 403);
  const sentResponse = await postJson(`${baseUrl}/api/messages`, { body: "رسالة آمنة" }, {
    Cookie: aliceCookie,
    "X-CSRF-Token": aliceSession.csrfToken
  });
  assert.equal(sentResponse.status, 201);
  const sent = await sentResponse.json();

  const received = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: bobCookie } }).then(response => response.json());
  assert.equal(received.messages.length, 1);
  assert.equal(received.messages[0].body, "رسالة آمنة");
  assert.ok(received.messages[0].createdAt);

  const readStatuses = await fetch(`${baseUrl}/api/messages?after=${sent.id}`, { headers: { Cookie: aliceCookie } })
    .then(response => response.json());
  assert.ok(readStatuses.readStatuses.some(status => status.id === sent.id && status.isRead));

  const reply = await postJson(`${baseUrl}/api/messages`, { body: "وصلتني رسالتك" }, {
    Cookie: bobCookie,
    "X-CSRF-Token": bobSession.csrfToken
  });
  assert.equal(reply.status, 201);
  const history = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: aliceCookie } }).then(response => response.json());
  assert.deepEqual(history.messages.map(message => message.body), ["رسالة آمنة", "وصلتني رسالتك"]);

  for (let index = 0; index < 51; index += 1) {
    const response = await postJson(`${baseUrl}/api/messages`, { body: `رسالة ${index}` }, {
      Cookie: aliceCookie,
      "X-CSRF-Token": aliceSession.csrfToken
    });
    assert.equal(response.status, 201);
  }
  const recent = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: aliceCookie } }).then(response => response.json());
  assert.equal(recent.messages.length, 50);
  assert.equal(recent.hasMore, true);
  const older = await fetch(`${baseUrl}/api/messages?before=${recent.messages[0].id}`, { headers: { Cookie: aliceCookie } })
    .then(response => response.json());
  assert.equal(older.messages.length, 3);
  assert.equal(older.hasMore, false);

  const logout = await postJson(`${baseUrl}/api/logout`, {}, {
    Cookie: aliceCookie,
    "X-CSRF-Token": aliceSession.csrfToken
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: aliceCookie } })).status, 401);

  assert.equal((await fetch(`${baseUrl}/private-chat`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/private-chat/`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/app.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/chat.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/not-a-route`)).status, 401);
});

test("login rate limits persist across API handler instances", async t => {
  const { pg, database } = await createPostgresDatabase();
  t.after(() => pg.close());
  const config = createConfig();
  const firstServer = createServer({ ...config, database });
  const firstUrl = await listen(firstServer);
  t.after(() => new Promise(resolve => firstServer.close(resolve)));
  const headers = { "X-Forwarded-For": "203.0.113.12" };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await postJson(`${firstUrl}/api/private-route`, { code: "wrong-code" }, headers);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { openChat: false });
  }
  const blocked = await postJson(`${firstUrl}/api/private-route`, { code: "wrong-code" }, headers);
  assert.equal(blocked.status, 429);

  const secondServer = createServer({ ...config, database });
  const secondUrl = await listen(secondServer);
  t.after(() => new Promise(resolve => secondServer.close(resolve)));
  const stillBlocked = await postJson(`${secondUrl}/api/private-route`, { code: "wrong-code" }, headers);
  assert.equal(stillBlocked.status, 429);
});

test("concurrent failed route attempts cannot exceed the shared limit", async t => {
  const { pg, database } = await createPostgresDatabase();
  t.after(() => pg.close());
  const server = createServer({ ...createConfig(), database });
  const baseUrl = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const headers = { "X-Forwarded-For": "203.0.113.13" };

  const responses = await Promise.all(Array.from({ length: 10 }, () =>
    postJson(`${baseUrl}/api/private-route`, { code: "wrong-code" }, headers)
  ));
  assert.equal(responses.filter(response => response.status === 200).length, 5);
  assert.equal(responses.filter(response => response.status === 429).length, 5);
});

test("SQLite migration preserves stored chat data without changing the source", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nasim-neon-migration-test-"));
  const sqlitePath = path.join(directory, "source.sqlite");
  const sqlite = new DatabaseSync(sqlitePath);
  sqlite.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, password_salt BLOB, password_hash BLOB, created_at TEXT);
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, created_at TEXT);
    CREATE TABLE conversation_members (conversation_id INTEGER, user_id INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id INTEGER, sender_id INTEGER, body TEXT, created_at TEXT);
    CREATE TABLE message_reads (message_id INTEGER, user_id INTEGER, read_at TEXT);
    CREATE TABLE sessions (session_hash TEXT, user_id INTEGER, csrf_token TEXT, expires_at INTEGER);
  `);
  const salt = crypto.randomBytes(16);
  const passwordHash = crypto.scryptSync("migration-test-password", salt, 64);
  sqlite.prepare("INSERT INTO users VALUES (1, 'alice', 'Alice', ?, ?, '2026-01-01T00:00:00.000Z')").run(salt, passwordHash);
  sqlite.prepare("INSERT INTO users VALUES (2, 'bob', 'Bob', ?, ?, '2026-01-01T00:00:00.000Z')").run(crypto.randomBytes(16), crypto.randomBytes(64));
  sqlite.prepare("INSERT INTO conversations VALUES (1, '2026-01-01T00:00:00.000Z')").run();
  sqlite.prepare("INSERT INTO conversation_members VALUES (1, 1), (1, 2)").run();
  sqlite.prepare("INSERT INTO messages VALUES (7, 1, 1, 'existing message', '2026-01-02T00:00:00.000Z')").run();
  sqlite.prepare("INSERT INTO message_reads VALUES (7, 2, NULL)").run();
  sqlite.prepare("INSERT INTO sessions VALUES ('session-hash', 1, 'csrf-token', 1999999999999)").run();
  sqlite.close();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const pg = new PGlite();
  t.after(() => pg.close());
  const result = await migrateSqliteToNeon({
    sqlitePath,
    client: { query: (sql, values = []) => pg.query(sql, values) }
  });
  assert.deepEqual(result, {
    users: 2,
    conversations: 1,
    conversation_members: 2,
    messages: 1,
    message_reads: 1,
    sessions: 1
  });

  const imported = await pg.query(`
    SELECT m.id, m.body, u.username, u.password_salt, u.password_hash
    FROM messages m JOIN users u ON u.id = m.sender_id
  `);
  assert.equal(imported.rows[0].id, 7);
  assert.equal(imported.rows[0].body, "existing message");
  assert.equal(imported.rows[0].username, "alice");
  assert.deepEqual(Buffer.from(imported.rows[0].password_salt), salt);
  assert.deepEqual(Buffer.from(imported.rows[0].password_hash), passwordHash);
  assert.equal(fs.existsSync(sqlitePath), true);
  const nextMessage = await pg.query(`
    INSERT INTO messages (conversation_id, sender_id, body, created_at)
    VALUES (1, 1, 'sequence check', '2026-01-03T00:00:00.000Z')
    RETURNING id
  `);
  assert.equal(nextMessage.rows[0].id, 8);

  await assert.rejects(
    migrateSqliteToNeon({ sqlitePath, client: { query: (sql, values = []) => pg.query(sql, values) } }),
    /not empty/
  );
  assert.equal((await pg.query("SELECT COUNT(*) AS count FROM messages")).rows[0].count, 2);

  const partialPg = new PGlite();
  t.after(() => partialPg.close());
  await partialPg.exec(fs.readFileSync(path.join(__dirname, "migrations", "001_initial.sql"), "utf8"));
  await partialPg.query(`
    INSERT INTO login_attempts (identity_hash, endpoint, attempts, window_expires_at)
    VALUES ('test-identity', 'login', 1, 1999999999999)
  `);
  await assert.rejects(
    migrateSqliteToNeon({ sqlitePath, client: { query: (sql, values = []) => partialPg.query(sql, values) } }),
    /not empty/
  );
});

test("Vercel entry points are isolated under api and browser assets stay outside it", () => {
  const apiFiles = ["private-route.js", "session.js", "login.js", "logout.js", "messages.js"];
  for (const file of apiFiles) {
    assert.equal(fs.existsSync(path.join(__dirname, "api", file)), true);
  }
  const appSource = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.match(appSource, /document\.getElementById/);
  assert.equal(fs.existsSync(path.join(__dirname, "api", "app.js")), false);
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "vercel.json"), "utf8"));
  assert.equal(vercelConfig.rewrites.some(rewrite => rewrite.destination === "/index.html"), true);
  const staticBuild = vercelConfig.builds.find(build => build.src === "error-messages.js");
  assert.equal(staticBuild?.use, "@vercel/static");
  assert.equal(fs.existsSync(path.join(__dirname, "error-messages.js")), true);
  const chatSource = fs.readFileSync(path.join(__dirname, "chat.js"), "utf8");
  assert.match(chatSource, /request\("\/api\/login"/);
  assert.match(chatSource, /request\("\/api\/session"/);
  const htmlSource = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  assert.match(htmlSource, /id="loginForm"/);
});
