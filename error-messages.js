(function exposeApiErrorMessage(root) {
  function getApiErrorMessage(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  if (typeof module === "object" && module.exports) {
    module.exports = { getApiErrorMessage };
  }
  root.getApiErrorMessage = getApiErrorMessage;
})(typeof window === "undefined" ? globalThis : window);
