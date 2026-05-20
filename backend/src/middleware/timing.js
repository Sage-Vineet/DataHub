// Logs any request that takes longer than SLOW_THRESHOLD_MS to complete.
// Attach early in the middleware stack (before route handlers) in app.js.
const SLOW_THRESHOLD_MS = 2000;

function timingMiddleware(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (ms >= SLOW_THRESHOLD_MS) {
      console.warn(
        `[SLOW_API] ${req.method} ${req.path} — ${ms}ms (status ${res.statusCode})`,
      );
    }
  });
  next();
}

module.exports = { timingMiddleware };
