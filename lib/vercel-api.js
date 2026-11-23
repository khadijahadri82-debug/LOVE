const { createApiHandler } = require("./api-handler");

let handler;

module.exports = async function vercelApi(req, res) {
  try {
    if (!handler) handler = createApiHandler();
    await handler(req, res);
  } catch (error) {
    const diagnostic = error.message === "DATABASE_URL is required."
      ? "DATABASE_URL is not configured"
      : error.code || error.name || "Error";
    console.error("API initialization failed:", diagnostic);
    if (!res.headersSent) {
      res.writeHead(503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      res.end(JSON.stringify({ error: "خدمة المحادثة غير مهيأة حالياً." }));
    }
  }
};
