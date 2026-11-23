const crypto = require("node:crypto");
const { createNeonDatabase } = require("./neon-database");

const SESSION_COOKIE = "nasim_private_chat";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4000;
const PAGE_SIZE = 50;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function hash(value, salt) {
  return crypto.scryptSync(value, salt, 64);
}

function safeEqual(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeConfig(options = {}) {
  const config = {
    sessionSecret: options.sessionSecret || process.env.CHAT_SESSION_SECRET || "",
    accessCode: options.accessCode || process.env.CHAT_ACCESS_CODE || "",
    accessTokens: options.accessTokens || [
      process.env.CHAT_TOKEN_1 || "",
      process.env.CHAT_TOKEN_2 || ""
    ],
    production: options.production === undefined ? process.env.NODE_ENV === "production" : options.production,
    participants: options.participants || [
      { username: process.env.CHAT_USER_1 || "" },
      { username: process.env.CHAT_USER_2 || "" }
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
  for (const participant of config.participants) {
    participant.username = String(participant.username || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(participant.username)) {
      throw new Error("Each chat username must be 3-32 letters, numbers, dots, underscores, or hyphens.");
    }
    if (usernames.has(participant.username)) {
      throw new Error("Chat usernames must be unique.");
    }
    usernames.add(participant.username);
  }

  return config;
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
  if (req.body !== undefined) {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > maxBytes) {
      return Promise.reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
    }
    try {
      return Promise.resolve(typeof req.body === "string" ? JSON.parse(req.body) : req.body);
    } catch {
      return Promise.reject(Object.assign(new Error("Invalid JSON request."), { status: 400 }));
    }
  }

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

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function createApiHandler(options = {}) {
  const config = normalizeConfig(options);
  const db = options.database || createNeonDatabase(options.databaseUrl);
  const accessCodeSalt = crypto.randomBytes(16);
  const accessCodeHash = hash(config.accessCode, accessCodeSalt);
  const accessTokenSalt = crypto.randomBytes(16);
  const accessTokenHashes = config.accessTokens.map(token => hash(token, accessTokenSalt));
  const dummySalt = crypto.randomBytes(16);
  const dummyHash = hash(crypto.randomBytes(32).toString("hex"), dummySalt);

  function signSession(sessionId) {
    return crypto.createHmac("sha256", config.sessionSecret).update(sessionId).digest("base64url");
  }

  function cookieHeader(value, maxAge) {
    const secure = config.production ? "; Secure" : "";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  function requestIdentity(req) {
    const forwarded = req.headers["x-forwarded-for"];
    const address = typeof forwarded === "string"
      ? forwarded.split(",")[0].trim()
      : req.socket?.remoteAddress || "unknown";
    return crypto.createHmac("sha256", config.sessionSecret).update(address).digest("hex");
  }

  async function consumeAttempt(identity, endpoint, now) {
    const rows = await db.query(`
      INSERT INTO login_attempts (identity_hash, endpoint, attempts, window_expires_at)
      VALUES ($1, $2, 1, $3)
      ON CONFLICT (identity_hash, endpoint) DO UPDATE SET
        attempts = CASE
          WHEN login_attempts.window_expires_at <= $4 THEN 1
          ELSE login_attempts.attempts + 1
        END,
        window_expires_at = CASE
          WHEN login_attempts.window_expires_at <= $4 THEN $3
          ELSE login_attempts.window_expires_at
        END
      RETURNING attempts, window_expires_at
    `, [identity, endpoint, now + LOGIN_WINDOW_MS, now]);
    return rows[0];
  }

  async function clearFailedAttempts(identity, endpoint) {
    await db.query(
      "DELETE FROM login_attempts WHERE identity_hash = $1 AND endpoint = $2",
      [identity, endpoint]
    );
  }

  async function insertSession(userId) {
    const now = Date.now();
    const sessionId = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex");
    const rows = await db.query(`
      INSERT INTO sessions (session_hash, user_id, csrf_token, expires_at)
      SELECT $1, u.id, $2, $3
      FROM users u
      JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = 1
      WHERE u.id = $4 AND u.username IN ($5, $6)
      RETURNING session_hash
    `, [
      sessionHash,
      csrfToken,
      expiresAt,
      userId,
      config.participants[0].username,
      config.participants[1].username
    ]);
    return rows.length
      ? cookieHeader(`${sessionId}.${signSession(sessionId)}`, SESSION_TTL_MS / 1000)
      : null;
  }

  async function getSession(req) {
    const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (!cookie) return null;
    const separator = cookie.lastIndexOf(".");
    if (separator < 1) return null;
    const sessionId = cookie.slice(0, separator);
    const signature = Buffer.from(cookie.slice(separator + 1), "base64url");
    const expected = Buffer.from(signSession(sessionId), "base64url");
    if (!safeEqual(signature, expected)) return null;

    const sessionHash = crypto.createHash("sha256").update(sessionId).digest("hex");
    const rows = await db.query(`
      SELECT s.session_hash, s.user_id, s.csrf_token, s.expires_at, u.display_name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN conversation_members cm ON cm.user_id = u.id AND cm.conversation_id = 1
      WHERE s.session_hash = $1 AND u.username IN ($2, $3)
    `, [sessionHash, config.participants[0].username, config.participants[1].username]);
    const session = rows[0];
    if (!session || Number(session.expires_at) <= Date.now()) {
      if (session) {
        await db.query("DELETE FROM sessions WHERE session_hash = $1", [sessionHash]);
      }
      return null;
    }
    return session;
  }

  async function handle(req, res) {
    setSecurityHeaders(res);
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) {
      return response(res, 404, { error: "المسار المطلوب غير موجود." });
    }
    res.setHeader("Cache-Control", "no-store");

    try {
      if (req.method === "POST" && url.pathname === "/api/private-route") {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return response(res, error.status || 400, { error: error.message });
        }
        if (!body || typeof body.code !== "string") {
          return response(res, 400, { error: "رمز البحث غير صالح." });
        }

        const address = requestIdentity(req);
        const now = Date.now();
        const attempt = await consumeAttempt(address, "private-route", now);
        if (Number(attempt.attempts) > LOGIN_LIMIT) {
          return response(res, 429, { error: "محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة." }, {
            "Retry-After": String(Math.max(1, Math.ceil((Number(attempt.window_expires_at) - now) / 1000)))
          });
        }

        const candidate = body.code.trim();
        const codeOk = candidate.length >= 4 && candidate.length <= 128
          && safeEqual(hash(candidate, accessCodeSalt), accessCodeHash);
        if (codeOk) {
          await clearFailedAttempts(address, "private-route");
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
          return response(res, 200, { openChat: false });
        }

        const users = await db.query(
          "SELECT id FROM users WHERE username = $1",
          [config.participants[tokenIndex].username]
        );
        const sessionCookie = users.length ? await insertSession(users[0].id) : null;
        if (!sessionCookie) {
          return response(res, 503, { error: "لم يتم إعداد حسابات المحادثة في قاعدة البيانات بعد." });
        }
        await clearFailedAttempts(address, "private-route");
        return response(res, 200, { openChat: true }, { "Set-Cookie": sessionCookie });
      }

      if (req.method === "GET" && url.pathname === "/api/session") {
        const session = await getSession(req);
        if (!session) return response(res, 200, { authenticated: false });
        const peers = await db.query(`
          SELECT u.display_name
          FROM conversation_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id = 1 AND cm.user_id != $1
        `, [session.user_id]);
        return response(res, 200, {
          authenticated: true,
          user: { id: session.user_id, displayName: session.display_name },
          peer: { displayName: peers[0]?.display_name || "" },
          csrfToken: session.csrf_token
        });
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return response(res, error.status || 400, { error: error.message });
        }
        if (!body || typeof body.username !== "string" || typeof body.password !== "string" || typeof body.accessCode !== "string") {
          return response(res, 400, { error: "أدخل اسم المستخدم وكلمة المرور ورمز الوصول." });
        }
        const address = requestIdentity(req);
        const now = Date.now();
        const attempt = await consumeAttempt(address, "login", now);
        if (Number(attempt.attempts) > LOGIN_LIMIT) {
          return response(res, 429, { error: "محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة." }, {
            "Retry-After": String(Math.max(1, Math.ceil((Number(attempt.window_expires_at) - now) / 1000)))
          });
        }
        const username = body.username.trim().toLowerCase();
        const isConfiguredParticipant = config.participants.some(participant => participant.username === username);
        const rows = isConfiguredParticipant
          ? await db.query(
            "SELECT id, username, password_salt, password_hash FROM users WHERE username = $1",
            [username]
          )
          : [];
        const user = rows[0];
        const salt = user ? Buffer.from(user.password_salt) : dummySalt;
        const expectedPassword = user ? Buffer.from(user.password_hash) : dummyHash;
        const passwordOk = safeEqual(hash(body.password, salt), expectedPassword);
        const codeOk = safeEqual(hash(body.accessCode.trim(), accessCodeSalt), accessCodeHash);
        const membership = user
          ? await db.query("SELECT 1 FROM conversation_members WHERE conversation_id = 1 AND user_id = $1", [user.id])
          : [];
        if (!user || !passwordOk || !codeOk || !membership.length) {
          return response(res, 401, { error: "بيانات الدخول أو رمز الوصول غير صحيح." });
        }

        const sessionCookie = await insertSession(user.id);
        if (!sessionCookie) return response(res, 403, { error: "الحساب غير مخول لهذه المحادثة." });
        await clearFailedAttempts(address, "login");
        return response(res, 200, { ok: true }, { "Set-Cookie": sessionCookie });
      }

      const session = await getSession(req);
      if (!session) return response(res, 401, { error: "سجّل الدخول للوصول إلى المحادثة." });

      if (req.method !== "GET" && req.headers["x-csrf-token"] !== session.csrf_token) {
        return response(res, 403, { error: "انتهت صلاحية الجلسة. سجّل الدخول من جديد." });
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        await db.query("DELETE FROM sessions WHERE session_hash = $1", [session.session_hash]);
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

        await db.query(`
          UPDATE message_reads SET read_at = $1
          WHERE user_id = $2 AND read_at IS NULL
            AND message_id IN (SELECT id FROM messages WHERE conversation_id = 1 AND sender_id != $2)
        `, [new Date().toISOString(), session.user_id]);

        let rows;
        let hasMore = false;
        if (afterValue !== null) {
          rows = await db.query(`
            SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at,
              EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $1) AS is_read
            FROM messages m JOIN users u ON u.id = m.sender_id
            JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
            WHERE m.conversation_id = 1 AND m.id > $3 ORDER BY m.id ASC LIMIT 100
          `, [session.user_id, session.user_id, anchor]);
        } else {
          const query = beforeValue === null
            ? `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at,
                 EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $1) AS is_read
               FROM messages m JOIN users u ON u.id = m.sender_id
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
               WHERE m.conversation_id = 1 ORDER BY m.id DESC LIMIT $3`
            : `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at,
                 EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = $1) AS is_read
               FROM messages m JOIN users u ON u.id = m.sender_id
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
               WHERE m.conversation_id = 1 AND m.id < $3 ORDER BY m.id DESC LIMIT $4`;
          const values = beforeValue === null
            ? [session.user_id, session.user_id, PAGE_SIZE + 1]
            : [session.user_id, session.user_id, anchor, PAGE_SIZE + 1];
          const page = await db.query(query, values);
          hasMore = page.length > PAGE_SIZE;
          rows = page.slice(0, PAGE_SIZE).reverse();
        }

        const readStatuses = await db.query(`
          SELECT m.id,
            EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id != $1 AND mr.read_at IS NOT NULL) AS is_read
          FROM messages m
          WHERE m.conversation_id = 1 AND m.sender_id = $1
          ORDER BY m.id DESC LIMIT 100
        `, [session.user_id]);
        return response(res, 200, {
          messages: rows.map(row => ({
            id: row.id,
            senderId: row.sender_id,
            senderName: row.sender_name,
            body: row.body,
            createdAt: row.created_at,
            isRead: Boolean(row.is_read)
          })),
          readStatuses: readStatuses.map(row => ({ id: row.id, isRead: Boolean(row.is_read) })),
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
        const inserted = await db.query(`
          WITH inserted AS (
            INSERT INTO messages (conversation_id, sender_id, body, created_at)
            VALUES (1, $1, $2, $3)
            RETURNING id, created_at
          ), receipts AS (
            INSERT INTO message_reads (message_id, user_id, read_at)
            SELECT inserted.id, cm.user_id, NULL
            FROM inserted
            JOIN conversation_members cm ON cm.conversation_id = 1 AND cm.user_id != $1
            RETURNING message_id
          )
          SELECT id, created_at FROM inserted
        `, [session.user_id, message, createdAt]);
        return response(res, 201, { ok: true, id: inserted[0].id, createdAt: inserted[0].created_at });
      }

      return response(res, 404, { error: "المسار المطلوب غير موجود." });
    } catch (error) {
      console.error("API request failed:", { path: url.pathname, code: error.code || error.name || "Error" });
      return response(res, 500, { error: "حدث خطأ غير متوقع. حاول مرة أخرى." });
    }
  }

  return handle;
}

module.exports = { createApiHandler };
