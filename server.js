const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SESSION_COOKIE = "nasim_private_chat";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4000;
const PAGE_SIZE = 50;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/private-chat", ["index.html", "text/html; charset=utf-8"]],
  ["/private-chat/", ["index.html", "text/html; charset=utf-8"]],
  ["/chat.js", ["chat.js", "text/javascript; charset=utf-8"]]
]);

function hash(value, salt) {
  return crypto.scryptSync(value, salt, 64);
}

function safeEqual(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function inTransaction(db, action) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeConfig(options = {}) {
  const config = {
    databasePath: options.databasePath || process.env.CHAT_DATABASE_PATH || path.join(__dirname, "data", "chat.sqlite"),
    sessionSecret: options.sessionSecret || process.env.CHAT_SESSION_SECRET || "",
    accessCode: options.accessCode || process.env.CHAT_ACCESS_CODE || "",
    accessTokens: options.accessTokens || [
      process.env.CHAT_TOKEN_1 || "",
      process.env.CHAT_TOKEN_2 || ""
    ],
    production: options.production === undefined ? process.env.NODE_ENV === "production" : options.production,
    participants: options.participants || [
      {
        username: process.env.CHAT_USER_1 || "",
        password: process.env.CHAT_PASSWORD_1 || "",
        displayName: process.env.CHAT_NAME_1 || ""
      },
      {
        username: process.env.CHAT_USER_2 || "",
        password: process.env.CHAT_PASSWORD_2 || "",
        displayName: process.env.CHAT_NAME_2 || ""
      }
    ]
  };

  if (Buffer.byteLength(config.sessionSecret) < 32) {
    throw new Error("CHAT_SESSION_SECRET must contain at least 32 characters.");
  }
  if (typeof config.accessCode !== "string" || config.accessCode.length < 4 || config.accessCode.length > 128) {
    throw new Error("CHAT_ACCESS_CODE must contain between 4 and 128 characters.");
  }
  if (!Array.isArray(config.accessTokens) || config.accessTokens.length !== 2
    || config.accessTokens.some(token => typeof token !== "string" || !/^[a-f0-9]{64}$/i.test(token))
    || new Set(config.accessTokens).size !== 2) {
    throw new Error("CHAT_TOKEN_1 and CHAT_TOKEN_2 must be different 64-character hexadecimal tokens.");
  }
  if (!Array.isArray(config.participants) || config.participants.length !== 2) {
    throw new Error("Exactly two chat participants must be configured.");
  }

  const usernames = new Set();
  const passwords = new Set();
  for (const participant of config.participants) {
    participant.username = String(participant.username || "").trim().toLowerCase();
    participant.displayName = String(participant.displayName || "").trim();
    if (!/^[a-z0-9._-]{3,32}$/.test(participant.username)) {
      throw new Error("Each chat username must be 3-32 letters, numbers, dots, underscores, or hyphens.");
    }
    if (usernames.has(participant.username)) {
      throw new Error("Chat usernames must be unique.");
    }
    usernames.add(participant.username);
    if (typeof participant.password !== "string" || participant.password.length < 12) {
      throw new Error(`A password of at least 12 characters is required for ${participant.username}.`);
    }
    if (passwords.has(participant.password)) {
      throw new Error("The two chat participants must use different passwords.");
    }
    passwords.add(participant.password);
    if (!participant.displayName || participant.displayName.length > 40) {
      throw new Error(`A display name of 1-40 characters is required for ${participant.username}.`);
    }
  }

  return config;
}

function createDatabase(config) {
  fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_salt BLOB NOT NULL,
      password_hash BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation_id_id ON messages(conversation_id, id);
    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
  `);

  const upsertUser = db.prepare(`
    INSERT INTO users (username, display_name, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      display_name = excluded.display_name,
      password_salt = excluded.password_salt,
      password_hash = excluded.password_hash
  `);
  const participantIds = [];
  for (const participant of config.participants) {
    const salt = crypto.randomBytes(16);
    upsertUser.run(
      participant.username,
      participant.displayName,
      salt,
      hash(participant.password, salt),
      new Date().toISOString()
    );
    participantIds.push(db.prepare("SELECT id FROM users WHERE username = ?").get(participant.username).id);
  }

  db.prepare("INSERT OR IGNORE INTO conversations (id, created_at) VALUES (1, ?)").run(new Date().toISOString());
  inTransaction(db, () => {
    db.prepare("DELETE FROM conversation_members WHERE conversation_id = 1").run();
    const addMember = db.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (1, ?)");
    for (const id of participantIds) addMember.run(id);
  });
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  return { db, participantIds };
}

function response(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        tooLarge = true;
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        reject(Object.assign(new Error("Send a JSON request."), { status: 415 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON request."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(header = "") {
  const cookies = new Map();
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0) cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return cookies;
}

function createServer(options = {}) {
  const config = normalizeConfig(options);
  const { db, participantIds } = createDatabase(config);
  const accessCodeSalt = crypto.randomBytes(16);
  const accessCodeHash = hash(config.accessCode, accessCodeSalt);
  const accessTokenSalt = crypto.randomBytes(16);
  const accessTokenHashes = config.accessTokens.map(token => hash(token, accessTokenSalt));
  const dummySalt = crypto.randomBytes(16);
  const dummyHash = hash(crypto.randomBytes(32).toString("hex"), dummySalt);
  const loginAttempts = new Map();
  const routeAttempts = new Map();

  function signSession(sessionId) {
    return crypto.createHmac("sha256", config.sessionSecret).update(sessionId).digest("base64url");
  }

  function cookieHeader(value, maxAge) {
    const secure = config.production ? "; Secure" : "";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  function createSessionCookie(userId) {
    const now = Date.now();
    const sessionId = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex");
    db.prepare("INSERT INTO sessions (session_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)")
      .run(sessionHash, userId, csrfToken, expiresAt);
    return cookieHeader(`${sessionId}.${signSession(sessionId)}`, SESSION_TTL_MS / 1000);
  }

  function getSession(req) {
    const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (!cookie) return null;
    const separator = cookie.lastIndexOf(".");
    if (separator < 1) return null;
    const sessionId = cookie.slice(0, separator);
    const signature = Buffer.from(cookie.slice(separator + 1), "base64url");
    const expected = Buffer.from(signSession(sessionId), "base64url");
    if (!safeEqual(signature, expected)) return null;

    const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex");
    const session = db.prepare(`
      SELECT s.session_hash, s.user_id, s.csrf_token, s.expires_at, u.display_name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = 1
      WHERE s.session_hash = ?
    `).get(sessionHash);
    if (!session || session.expires_at <= Date.now()) {
      if (session) db.prepare("DELETE FROM sessions WHERE session_hash = ?").run(sessionHash);
      return null;
    }
    return session;
  }

  function setSecurityHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }

  async function handle(req, res) {
    setSecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "POST" && url.pathname === "/api/private-route") {
        const address = req.socket.remoteAddress || "unknown";
        const now = Date.now();
        const attempts = routeAttempts.get(address);
        if (attempts && attempts.expiresAt <= now) routeAttempts.delete(address);
        const current = routeAttempts.get(address);
        if (current && current.count >= LOGIN_LIMIT) {
          return response(res, 429, { error: "محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة." }, {
            "Retry-After": String(Math.ceil((current.expiresAt - now) / 1000))
          });
        }

        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return response(res, error.status || 400, { error: error.message });
        }
        if (!body || typeof body.code !== "string") {
          return response(res, 400, { error: "رمز البحث غير صالح." });
        }

        const candidate = body.code.trim();
        const codeOk = candidate.length >= 4 && candidate.length <= 128
          && safeEqual(hash(candidate, accessCodeSalt), accessCodeHash);
        if (codeOk) {
          routeAttempts.delete(address);
          return response(res, 200, { openChat: true });
        }

        let tokenIndex = -1;
        if (/^[a-f0-9]{64}$/i.test(candidate)) {
          const candidateHash = hash(candidate, accessTokenSalt);
          for (let index = 0; index < accessTokenHashes.length; index += 1) {
            if (safeEqual(candidateHash, accessTokenHashes[index])) tokenIndex = index;
          }
        }
        if (tokenIndex === -1) {
          const entry = current || { count: 0, expiresAt: now + LOGIN_WINDOW_MS };
          entry.count += 1;
          routeAttempts.set(address, entry);
          return response(res, 200, { openChat: false });
        }

        routeAttempts.delete(address);
        return response(res, 200, { openChat: true }, {
          "Set-Cookie": createSessionCookie(participantIds[tokenIndex])
        });
      }

      if (req.method === "GET" && url.pathname === "/api/session") {
        const session = getSession(req);
        if (!session) return response(res, 200, { authenticated: false });
        const peer = db.prepare(`
          SELECT u.display_name
          FROM conversation_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id = 1 AND cm.user_id != ?
        `).get(session.user_id);
        return response(res, 200, {
          authenticated: true,
          user: { id: session.user_id, displayName: session.display_name },
          peer: { displayName: peer.display_name },
          csrfToken: session.csrf_token
        });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const address = req.socket.remoteAddress || "unknown";
        const now = Date.now();
        const attempts = loginAttempts.get(address);
        if (attempts && attempts.expiresAt <= now) loginAttempts.delete(address);
        const current = loginAttempts.get(address);
        if (current && current.count >= LOGIN_LIMIT) {
          return response(res, 429, { error: "محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة." }, {
            "Retry-After": String(Math.ceil((current.expiresAt - now) / 1000))
          });
        }

        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return response(res, error.status || 400, { error: error.message });
        }
        if (!body || typeof body.username !== "string" || typeof body.password !== "string" || typeof body.accessCode !== "string") {
          return response(res, 400, { error: "أدخل اسم المستخدم وكلمة المرور ورمز الوصول." });
        }
        const username = body.username.trim().toLowerCase();
        const user = db.prepare("SELECT id, username, password_salt, password_hash FROM users WHERE username = ?").get(username);
        const salt = user ? user.password_salt : dummySalt;
        const expectedPassword = user ? user.password_hash : dummyHash;
        const passwordOk = safeEqual(hash(body.password, salt), expectedPassword);
        const codeOk = safeEqual(hash(body.accessCode.trim(), accessCodeSalt), accessCodeHash);
        const isMember = user && db.prepare("SELECT 1 FROM conversation_members WHERE conversation_id = 1 AND user_id = ?").get(user.id);
        if (!user || !passwordOk || !codeOk || !isMember) {
          const entry = current || { count: 0, expiresAt: now + LOGIN_WINDOW_MS };
          entry.count += 1;
          loginAttempts.set(address, entry);
          return response(res, 401, { error: "بيانات الدخول أو رمز الوصول غير صحيح." });
        }

        loginAttempts.delete(address);
        return response(res, 200, { ok: true }, { "Set-Cookie": createSessionCookie(user.id) });
      }

      const session = getSession(req);
      if (!session) return response(res, 401, { error: "سجّل الدخول للوصول إلى المحادثة." });

      if (req.method !== "GET" && req.headers["x-csrf-token"] !== session.csrf_token) {
        return response(res, 403, { error: "انتهت صلاحية الجلسة. سجّل الدخول من جديد." });
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        db.prepare("DELETE FROM sessions WHERE session_hash = ?").run(session.session_hash);
        return response(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
      }

      if (req.method === "GET" && url.pathname === "/api/messages") {
        const afterValue = url.searchParams.get("after");
        const beforeValue = url.searchParams.get("before");
        if (afterValue !== null && beforeValue !== null) {
          return response(res, 400, { error: "استخدم مؤشر رسائل واحداً في كل مرة." });
        }
        const anchorValue = afterValue !== null ? afterValue : beforeValue;
        const anchor = anchorValue === null ? null : Number(anchorValue);
        const minimumAnchor = afterValue !== null ? 0 : 1;
        if (anchorValue !== null && (!/^\d+$/.test(anchorValue) || !Number.isSafeInteger(anchor) || anchor < minimumAnchor)) {
          return response(res, 400, { error: "مؤشر الرسائل غير صالح." });
        }

        db.prepare(`
          UPDATE message_reads SET read_at = ?
          WHERE user_id = ? AND read_at IS NULL
            AND message_id IN (SELECT id FROM messages WHERE conversation_id = 1 AND sender_id != ?)
        `).run(new Date().toISOString(), session.user_id, session.user_id);

        let rows;
        let hasMore = false;
        if (afterValue !== null) {
          rows = db.prepare(`
            SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at,
              EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?) AS is_read
            FROM messages m JOIN users u ON u.id = m.sender_id
            JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
            WHERE m.conversation_id = 1 AND m.id > ? ORDER BY m.id ASC LIMIT 100
          `).all(session.user_id, session.user_id, anchor);
        } else {
          const query = beforeValue === null
            ? `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at,
                 EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?) AS is_read
               FROM messages m JOIN users u ON u.id = m.sender_id
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
               WHERE m.conversation_id = 1 ORDER BY m.id DESC LIMIT ?`
            : `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at,
                 EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?) AS is_read
               FROM messages m JOIN users u ON u.id = m.sender_id
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
               WHERE m.conversation_id = 1 AND m.id < ? ORDER BY m.id DESC LIMIT ?`;
          const values = beforeValue === null
            ? [session.user_id, session.user_id, PAGE_SIZE + 1]
            : [session.user_id, session.user_id, anchor, PAGE_SIZE + 1];
          const page = db.prepare(query).all(...values);
          hasMore = page.length > PAGE_SIZE;
          rows = page.slice(0, PAGE_SIZE).reverse();
        }

        const readStatuses = db.prepare(`
          SELECT m.id,
            EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id != ? AND mr.read_at IS NOT NULL) AS is_read
          FROM messages m
          WHERE m.conversation_id = 1 AND m.sender_id = ?
          ORDER BY m.id DESC LIMIT 100
        `).all(session.user_id, session.user_id).map(row => ({ id: row.id, isRead: Boolean(row.is_read) }));
        return response(res, 200, {
          messages: rows.map(row => ({
            id: row.id,
            senderId: row.sender_id,
            senderName: row.sender_name,
            body: row.body,
            createdAt: row.created_at,
            isRead: Boolean(row.is_read)
          })),
          readStatuses,
          hasMore
        });
      }

      if (req.method === "POST" && url.pathname === "/api/messages") {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return response(res, error.status || 400, { error: error.message });
        }
        if (!body || typeof body.body !== "string") {
          return response(res, 400, { error: "أدخل نص الرسالة." });
        }
        const message = body.body.trim();
        if (!message || message.length > MAX_MESSAGE_LENGTH) {
          return response(res, 400, { error: `يجب أن يتراوح نص الرسالة بين 1 و${MAX_MESSAGE_LENGTH} حرف.` });
        }

        const createdAt = new Date().toISOString();
        const messageId = inTransaction(db, () => {
          const result = db.prepare("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (1, ?, ?, ?)")
            .run(session.user_id, message, createdAt);
          const members = db.prepare("SELECT user_id FROM conversation_members WHERE conversation_id = 1 AND user_id != ?").all(session.user_id);
          const addReadStatus = db.prepare("INSERT INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, NULL)");
          for (const member of members) addReadStatus.run(result.lastInsertRowid, member.user_id);
          return result.lastInsertRowid;
        });
        return response(res, 201, { ok: true, id: messageId, createdAt });
      }

      return response(res, 404, { error: "المسار المطلوب غير موجود." });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Method not allowed");
    }
    const file = PUBLIC_FILES.get(url.pathname);
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const filePath = path.join(__dirname, file[0]);
    const contents = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-cache",
      "Content-Length": contents.length
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      console.error("Request failed:", error.message);
      if (!res.headersSent) response(res, 500, { error: "حدث خطأ غير متوقع. حاول مرة أخرى." });
      else res.destroy();
    });
  });

  server.on("close", () => db.close());
  return server;
}

if (require.main === module) {
  let server;
  try {
    server = createServer();
    const host = process.env.HOST || "0.0.0.0";
    const port = Number(process.env.PORT || 3000);
    server.listen(port, host, () => {
      console.log(`Nasim poetry site listening at http://${host}:${server.address().port}`);
    });
    server.on("error", error => {
      console.error("Unable to start the chat server:", error.message);
      process.exitCode = 1;
    });
    const shutdown = () => server.close(() => process.exit());
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Unable to start the chat server:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { createServer };
