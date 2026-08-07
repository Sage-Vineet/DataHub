/**
 * Live smoke test of the security middleware chain.
 * Boots the real app on an ephemeral port and exercises it over HTTP.
 */
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "test-secret-with-plenty-of-entropy-abcdefghijklmnop";
process.env.JWT_REFRESH_SECRET = "different-refresh-secret-with-entropy-qrstuvwxyz123";
process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com";

const http = require("http");
const app = require("../src/app.js");

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: !!condition, detail });
}

function request(server, { method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  // ── 1. Security headers ───────────────────────────────────────────────────
  const health = await request(server, { path: "/health" });
  check("health responds 200", health.status === 200);
  check("X-Powered-By removed", !health.headers["x-powered-by"], health.headers["x-powered-by"]);
  check("X-Content-Type-Options: nosniff", health.headers["x-content-type-options"] === "nosniff");
  check("X-Frame-Options: DENY", health.headers["x-frame-options"] === "DENY");
  check("CSP present", /default-src 'none'/.test(health.headers["content-security-policy"] || ""));
  check("Referrer-Policy set", !!health.headers["referrer-policy"]);
  check("Cross-Origin-Resource-Policy set", !!health.headers["cross-origin-resource-policy"]);
  check("Permissions-Policy set", !!health.headers["permissions-policy"]);
  check("X-Request-Id present", !!health.headers["x-request-id"]);
  check("Cache-Control no-store", /no-store/.test(health.headers["cache-control"] || ""));

  // ── 2. Auth required ──────────────────────────────────────────────────────
  const noAuth = await request(server, { path: "/auth/me" });
  check("/auth/me requires auth (401)", noAuth.status === 401, `got ${noAuth.status}`);

  // Previously-open endpoint: PUT /api/customers/:id
  const openEndpoint = await request(server, {
    method: "PUT",
    path: "/api/customers/123",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x: 1 }),
  });
  check(
    "PUT /api/customers/:id now requires auth",
    openEndpoint.status === 401,
    `got ${openEndpoint.status}: ${openEndpoint.body.slice(0, 120)}`
  );

  // ── 3. Query-string token no longer accepted ──────────────────────────────
  const jwt = require("jsonwebtoken");
  const forged = jwt.sign({ sub: "00000000-0000-0000-0000-000000000001" }, "change_me");
  const qsToken = await request(server, { path: `/auth/me?token=${forged}` });
  check("query-string token rejected", qsToken.status === 401, `got ${qsToken.status}`);

  const hdrToken = await request(server, {
    path: "/auth/me",
    headers: { "x-access-token": forged },
  });
  check("x-access-token header rejected", hdrToken.status === 401, `got ${hdrToken.status}`);

  // ── 4. "change_me" fallback secret no longer works ────────────────────────
  const bearerForged = await request(server, {
    path: "/auth/me",
    headers: { authorization: `Bearer ${forged}` },
  });
  check(
    "token signed with 'change_me' rejected",
    bearerForged.status === 401,
    `got ${bearerForged.status}`
  );

  // ── 5. CORS ───────────────────────────────────────────────────────────────
  const badOrigin = await request(server, {
    path: "/health",
    headers: { origin: "https://evil.vercel.app" },
  });
  check(
    "rogue *.vercel.app origin rejected",
    badOrigin.status === 403 || !badOrigin.headers["access-control-allow-origin"],
    `status ${badOrigin.status}, acao=${badOrigin.headers["access-control-allow-origin"]}`
  );

  const goodOrigin = await request(server, {
    path: "/health",
    headers: { origin: "https://app.example.com" },
  });
  check(
    "allowlisted origin accepted",
    goodOrigin.headers["access-control-allow-origin"] === "https://app.example.com",
    goodOrigin.headers["access-control-allow-origin"]
  );

  // ── 6. Validation & error shape ───────────────────────────────────────────
  const badLogin = await request(server, {
    method: "POST",
    path: "/auth/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", password: "x", role: "admin" }),
  });
  check("invalid login body rejected 400", badLogin.status === 400, `got ${badLogin.status}`);
  check(
    "mass-assignment key rejected by strict schema",
    /role/.test(badLogin.body),
    badLogin.body.slice(0, 200)
  );

  const malformed = await request(server, {
    method: "POST",
    path: "/auth/login",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  check("malformed JSON -> 400 generic", malformed.status === 400, `got ${malformed.status}`);
  check("no stack trace in error body", !/at\s+\w+.*:\d+:\d+/.test(malformed.body), malformed.body.slice(0, 150));

  // ── 7. 404 shape ──────────────────────────────────────────────────────────
  const notFound = await request(server, { path: "/definitely-not-a-route-xyz" });
  // 401 rather than 404 is correct and deliberate: routers mounted at "/" apply
  // requireAuth before any route matches, so an unauthenticated caller cannot
  // enumerate which paths exist. Authenticated callers get a 404.
  check(
    "unknown route -> 401/404, never a stack trace",
    (notFound.status === 404 || notFound.status === 401) && !/ats+w+.*:d+:d+/.test(notFound.body),
    `got ${notFound.status}`
  );

  // ── 8. Rate limiting ──────────────────────────────────────────────────────
  let sawRateLimit = false;
  let last = null;
  for (let i = 0; i < 15; i += 1) {
    last = await request(server, {
      method: "POST",
      path: "/auth/login",
      // Send Origin so the response is judged exactly as a browser would.
      headers: { "content-type": "application/json", origin: "https://app.example.com" },
      body: JSON.stringify({ email: `a${i}@example.com`, password: "wrongpassword1" }),
    });
    if (last.status === 429) {
      sawRateLimit = true;
      break;
    }
  }
  check("auth endpoint rate limits to 429", sawRateLimit, `last status ${last.status}`);
  check("429 carries Retry-After", !sawRateLimit || !!last.headers["retry-after"]);

  /**
   * A 429 MUST carry Access-Control-Allow-Origin.
   *
   * The rate limiters were originally mounted ahead of cors(), so every 429 went
   * out with no CORS headers. The browser discards such a response before any
   * JavaScript sees it and `fetch()` rejects with an opaque "Failed to fetch" —
   * so a rate-limited user got an error indistinguishable from the server being
   * down, and retrying (which adds strikes) made it worse. The limit worked
   * perfectly and was completely invisible.
   */
  check(
    "429 carries Access-Control-Allow-Origin (browser can read it)",
    !sawRateLimit || last.headers["access-control-allow-origin"] === "https://app.example.com",
    `acao=${last.headers["access-control-allow-origin"]}`
  );
  check(
    "429 body is readable JSON with a code",
    !sawRateLimit || /"code"\s*:\s*"(RATE_LIMITED|TEMPORARILY_BLOCKED)"/.test(last.body),
    last.body.slice(0, 120)
  );

  server.close();

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("\n=== SMOKE TEST RESULTS ===");
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed += 1;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail && !r.pass ? `  [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE TEST CRASHED:", e);
  process.exit(2);
});
