const assert = require("node:assert/strict");
const test = require("node:test");
const { getApiErrorMessage } = require("./error-messages");

test("structured API errors use a readable fallback instead of object coercion", () => {
  const fallback = "Unable to sign in. Please try again.";

  assert.equal(getApiErrorMessage({ code: "FUNCTION_INVOCATION_FAILED" }, fallback), fallback);
  assert.equal(getApiErrorMessage({ message: "internal database details" }, fallback), fallback);
  assert.equal(getApiErrorMessage("Invalid credentials.", fallback), "Invalid credentials.");
  assert.equal(getApiErrorMessage("  ", fallback), fallback);
});
