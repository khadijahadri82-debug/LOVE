# Nasim poetry site and private chat

The poetry site and private chat are one application served by the same Node server. Both `/` and `/private-chat` load the main `index.html`; the existing `app.js` router renders the chat as a private route. The route is not shown in the site's navigation.

## Run locally

Use Node.js 22.13 or newer. Copy `.env.example` to `.env`, replace every placeholder with private values, then run:

```sh
npm start
```

The server binds to `HOST` (default `0.0.0.0`) and listens on `PORT` (default `3000`). The `npm start` script loads `.env`; environment variables already set by the shell or hosting provider take precedence. The server requires two distinct participant accounts, two unique server-side passwords of at least 12 characters, display names, a `CHAT_SESSION_SECRET` of at least 32 characters, and two different 64-character hexadecimal access tokens.

Give `CHAT_TOKEN_1` only to participant one and `CHAT_TOKEN_2` only to participant two. Each enters their token in the poetry search field to open chat without a username/password screen. The server verifies the token, maps it to that participant, and creates the existing signed, HttpOnly session; chat APIs continue to authorize only conversation members. Tokens are not stored in the database or sent in frontend source. The configured short route code only opens the private route for an already-authenticated session; it does not grant message access by itself. Password hashes and messages remain in the SQLite database at `data/chat.sqlite` by default. Protect that database file and back it up securely.

For Render, use Node.js 22.13 or newer, set the build command to `npm ci` and the start command to `npm start`. Render supplies `PORT`; bind to `0.0.0.0` (the server default). Set `NODE_ENV=production` and configure `CHAT_ACCESS_CODE`, participant credentials, tokens, and session settings as private environment variables. Attach a persistent disk and set `CHAT_DATABASE_PATH` to a file path on that disk; SQLite data on an ephemeral filesystem can be lost when the service restarts or redeploys. Do not upload `.env`, database files, or backups.

Sessions expire after 12 hours. Access-token and legacy login attempts are limited per client address. Message and session APIs require an authorized conversation membership; state-changing requests also require a session CSRF token. Messages update by polling, with paginated history and read receipts.

## Tests

Run `npm test` for backend authentication, access-code, authorization, message history/delivery, read-status, and logout tests. Start the server with the required environment variables to use the site in a browser.
