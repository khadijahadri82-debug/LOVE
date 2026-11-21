const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("./server");

test("private chat requires both authorized accounts and the access code", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nasim-chat-test-"));
  const databasePath = path.join(directory, "chat.sqlite");
  const accessTokens = ["a".repeat(64), "b".repeat(64)];
  assert.throws(() => createServer({
    databasePath,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    accessCode: "test-private-route-code",
    accessTokens,
    participants: [
      { username: "alice", password: "same-account-password", displayName: "Alice" },
      { username: "bob", password: "same-account-password", displayName: "Bob" }
    ]
  }), /different passwords/);
  const server = createServer({
    databasePath,
    sessionSecret: crypto.randomBytes(32).toString("hex"),
    accessCode: "test-private-route-code",
    accessTokens,
    participants: [
      { username: "alice", password: "alice-test-password-2026", displayName: "Alice" },
      { username: "bob", password: "bob-test-password-2026!!", displayName: "Bob" }
    ]
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function login(username, password, accessCode = "test-private-route-code") {
    const response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, accessCode })
    });
    return { response, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }

  const restricted = await fetch(`${baseUrl}/api/messages`);
  assert.equal(restricted.status, 401);

  const routeCode = async code => fetch(`${baseUrl}/api/private-route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  });
  const validRoute = await routeCode(" test-private-route-code ");
  assert.deepEqual(await validRoute.json(), { openChat: true });
  assert.equal(validRoute.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${baseUrl}/api/messages`)).status, 401);

  const aliceTokenRoute = await routeCode(` ${accessTokens[0]} `);
  assert.deepEqual(await aliceTokenRoute.json(), { openChat: true });
  const aliceTokenCookie = aliceTokenRoute.headers.get("set-cookie")?.split(";")[0];
  assert.match(aliceTokenRoute.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const aliceTokenSession = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: aliceTokenCookie }
  }).then(response => response.json());
  assert.equal(aliceTokenSession.authenticated, true);
  assert.equal(aliceTokenSession.user.displayName, "Alice");
  assert.equal((await fetch(`${baseUrl}/api/messages`, {
    headers: { Cookie: aliceTokenCookie }
  })).status, 200);

  const bobTokenRoute = await routeCode(accessTokens[1]);
  assert.deepEqual(await bobTokenRoute.json(), { openChat: true });
  const bobTokenCookie = bobTokenRoute.headers.get("set-cookie")?.split(";")[0];
  const bobTokenSession = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: bobTokenCookie }
  }).then(response => response.json());
  assert.equal(bobTokenSession.authenticated, true);
  assert.equal(bobTokenSession.user.displayName, "Bob");

  const invalidRoute = await routeCode("c".repeat(64));
  assert.deepEqual(await invalidRoute.json(), { openChat: false });
  assert.equal(invalidRoute.headers.get("set-cookie"), null);
  assert.equal((await fetch(`${baseUrl}/api/messages`)).status, 401);

  const wrongCode = await login("alice", "alice-test-password-2026", "NOPE");
  assert.equal(wrongCode.response.status, 401);
  const wrongPassword = await login("alice", "not-the-account-password");
  assert.equal(wrongPassword.response.status, 401);
  const unknownAccount = await login("mallory", "unknown-user-password-2026");
  assert.equal(unknownAccount.response.status, 401);

  const alice = await login("alice", "alice-test-password-2026", " test-private-route-code ");
  assert.equal(alice.response.status, 200);
  assert.match(alice.response.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const aliceSession = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: alice.cookie } }).then(response => response.json());
  assert.equal(aliceSession.authenticated, true);
  assert.equal(aliceSession.peer.displayName, "Bob");

  const emptyPoll = await fetch(`${baseUrl}/api/messages?after=0`, { headers: { Cookie: alice.cookie } });
  assert.equal(emptyPoll.status, 200);
  assert.deepEqual((await emptyPoll.json()).messages, []);
  assert.equal((await fetch(`${baseUrl}/api/messages?after=`, { headers: { Cookie: alice.cookie } })).status, 400);

  const unauthorizedSend = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "not authorized" })
  });
  assert.equal(unauthorizedSend.status, 401);

  const send = async (cookie, csrfToken, body) => fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ body })
  });
  const csrfHeaders = cookie => fetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } })
    .then(response => response.json());

  const csrfMissing = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { Cookie: alice.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ body: "missing CSRF" })
  });
  assert.equal(csrfMissing.status, 403);
  const messageSent = await send(alice.cookie, aliceSession.csrfToken, "رسالة آمنة");
  assert.equal(messageSent.status, 201);
  const firstMessage = await messageSent.json();

  const bob = await login("bob", "bob-test-password-2026!!");
  assert.equal(bob.response.status, 200);
  const bobSession = await csrfHeaders(bob.cookie);
  const received = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: bob.cookie } }).then(response => response.json());
  assert.equal(received.messages.length, 1);
  assert.equal(received.messages[0].body, "رسالة آمنة");
  assert.ok(received.messages[0].createdAt);

  const aliceUpdates = await fetch(`${baseUrl}/api/messages?after=${firstMessage.id}`, { headers: { Cookie: alice.cookie } })
    .then(response => response.json());
  assert.ok(aliceUpdates.readStatuses.some(status => status.id === firstMessage.id && status.isRead));

  const reply = await send(bob.cookie, bobSession.csrfToken, "وصلتني رسالتك");
  assert.equal(reply.status, 201);
  const history = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: alice.cookie } }).then(response => response.json());
  assert.deepEqual(history.messages.map(message => message.body), ["رسالة آمنة", "وصلتني رسالتك"]);

  for (let index = 0; index < 51; index += 1) {
    const sent = await send(alice.cookie, aliceSession.csrfToken, `سجل الرسائل ${index}`);
    assert.equal(sent.status, 201);
  }
  const recentPage = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: alice.cookie } }).then(response => response.json());
  assert.equal(recentPage.messages.length, 50);
  assert.equal(recentPage.hasMore, true);
  const olderPage = await fetch(`${baseUrl}/api/messages?before=${recentPage.messages[0].id}`, { headers: { Cookie: alice.cookie } }).then(response => response.json());
  assert.equal(olderPage.messages.length, 3);
  assert.equal(olderPage.hasMore, false);

  const logout = await fetch(`${baseUrl}/api/logout`, {
    method: "POST",
    headers: { Cookie: alice.cookie, "Content-Type": "application/json", "X-CSRF-Token": aliceSession.csrfToken },
    body: "{}"
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/messages`, { headers: { Cookie: alice.cookie } });
  assert.equal(afterLogout.status, 401);

  const db = new DatabaseSync(databasePath);
  const stored = JSON.stringify(db.prepare("SELECT username, password_hash FROM users").all());
  db.close();
  assert.equal(stored.includes("test-private-route-code"), false);
  assert.equal(stored.includes("alice-test-password-2026"), false);

  const privatePage = await fetch(`${baseUrl}/private-chat`);
  assert.equal(privatePage.status, 200);
  const integratedPage = await privatePage.text();
  assert.match(integratedPage, /<main id="app"/);
  assert.match(integratedPage, /id="privateChatTemplate"/);
  assert.equal(integratedPage.includes("test-private-route-code"), false);
  assert.equal((await fetch(`${baseUrl}/private-chat/`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/chat.html`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/chat.css`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/chat.js`)).status, 200);
  const appScript = await fetch(`${baseUrl}/app.js`).then(response => response.text());
  assert.equal(appScript.includes("test-private-route-code"), false);
  assert.equal(appScript.includes(accessTokens[0]), false);
  assert.equal(appScript.includes(accessTokens[1]), false);
});
