function isQuickBooksDebugEnabled() {
  return (
    process.env.QB_DEBUG_LOGS === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

function maskValue(value, visibleStart = 6, visibleEnd = 4) {
  const input = String(value || "");

  if (!input) return null;
  if (input.length <= visibleStart + visibleEnd) return input;

  return `${input.slice(0, visibleStart)}...${input.slice(-visibleEnd)}`;
}

function logQuickBooksDebug(event, details = {}) {
  if (!isQuickBooksDebugEnabled()) return;

  const payload =
    details && typeof details === "object" ? details : { value: details };

  console.log(`[QB DEBUG] ${event}`, payload);
}

module.exports = {
  isQuickBooksDebugEnabled,
  logQuickBooksDebug,
  maskValue,
};
