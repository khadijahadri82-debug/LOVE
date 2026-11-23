const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createApiHandler } = require("./lib/api-handler");

const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/private-chat", ["index.html", "text/html; charset=utf-8"]],
  ["/private-chat/", ["index.html", "text/html; charset=utf-8"]],
  ["/chat.js", ["chat.js", "text/javascript; charset=utf-8"]]
]);

function createServer(options = {}) {
  const apiHandler = createApiHandler(options);

  return http.createServer((req, res) => {
    if (new URL(req.url, "http://localhost").pathname.startsWith("/api/")) {
      apiHandler(req, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const file = PUBLIC_FILES.get(url.pathname);
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    try {
      const contents = fs.readFileSync(path.join(__dirname, file[0]));
      res.writeHead(200, {
        "Content-Type": file[1],
        "Cache-Control": "no-cache",
        "Content-Length": contents.length,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      });
      res.end(req.method === "HEAD" ? undefined : contents);
    } catch (error) {
      console.error("Static file request failed:", error.code || error.name || "Error");
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal server error");
    }
  });
}

if (require.main === module) {
  let server;
  try {
    server = createServer();
    const host = process.env.HOST || "127.0.0.1";
    const port = Number(process.env.PORT || 3000);
    server.listen(port, host, () => {
      console.log(`Nasim poetry site listening at http://${host}:${server.address().port}`);
    });
    server.on("error", error => {
      console.error("Unable to start the local server:", error.code || error.name || "Error");
      process.exitCode = 1;
    });
    const shutdown = () => server.close(() => process.exit());
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Unable to start the local server:", error.message);
    process.exitCode = 1;
  }
}

module.exports = { createServer };
