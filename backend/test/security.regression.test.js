"use strict";

/**
 * Regression tests — one per vulnerability that was found live in this codebase.
 *
 * Each test is named after the issue it closes and fails if the original
 * behaviour ever returns. These are the checks that matter most: every one of
 * them would have passed before the fix and failed after the bug was
 * reintroduced.
 *
 * Run:  npm run test:security
 */

process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "regression-access-secret-with-entropy-abcdefghij";
process.env.JWT_REFRESH_SECRET = "regression-refresh-secret-with-entropy-klmnopq";
process.env.CORS_ALLOWED_ORIGINS = "https://app.example.com";

const http = require("http");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const SRC = path.join(__dirname, "..", "src");
const REPO = path.join(__dirname, "..", "..");

const results = [];
function check(id, name, pass, detail = "") {
  results.push({ id, name, pass: pass === true, detail: pass === true ? "" : String(detail || pass) });
}

function readSrc(relative) {
  return fs.readFileSync(path.join(SRC, relative), "utf8");
}

/** Strips line and block comments so a grep cannot match explanatory prose. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function request(server, { method = "GET", path: urlPath = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const app = require("../src/app");
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));

  // ── V1: Gmail app password committed to a tracked template ────────────────
  {
    const template = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
    const gmailPattern = /^[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}$/im;
    check("V1", "no Gmail app password in .env.example", !gmailPattern.test(template));

    // Only flag a secret-shaped KEY holding a long unbroken VALUE. Trailing
    // inline comments are stripped first, otherwise a documented tunable like
    // `ACCESS_TOKEN_TTL_SECONDS=900   # 15 min` trips the "TOKEN" substring.
    const populated = template
      .split("\n")
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter((line) => /^[A-Z_]*(SECRET|PASSWORD|APIKEY|API_KEY|PASS|TOKEN)[A-Z_]*=\S{16,}$/.test(line))
      .filter((line) => !/=(your_|<|\$\{|CHANGE|REPLACE|example|npm:)/i.test(line));
    check("V1", "no populated secrets in .env.example", populated.length === 0, populated.join("; "));

    // History is a separate matter — surfaced, not asserted, because only a
    // credential rotation actually closes it.
    let inHistory = false;
    try {
      const head = execFileSync("git", ["show", "HEAD:backend/.env.example"], {
        cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      inHistory = gmailPattern.test(head);
    } catch { /* file absent from HEAD */ }
    if (inHistory) {
      console.log("\n\x1b[33mNOTE\x1b[0m  The credential is still present in git HEAD.");
      console.log("      Rotating it at Google is the only thing that closes this.\n");
    }
  }

  // ── V2: JWT_SECRET fallback to "change_me" ────────────────────────────────
  {
    const files = ["middleware/auth.js", "services/authService.js", "controllers/auth.js",
                   "services/otpService.js", "security/tokens.js"];
    const offenders = files.filter((f) =>
      /(JWT_SECRET|SECRET)\s*\|\|\s*["']/.test(codeOnly(readSrc(f))));
    check("V2", "no fallback signing secret in code", offenders.length === 0, offenders.join(", "));

    const jwt = require("jsonwebtoken");
    const forged = jwt.sign({ sub: "u1", typ: "access" }, "change_me");
    const res = await request(server, {
      path: "/auth/me", headers: { authorization: `Bearer ${forged}` },
    });
    check("V2", "token signed with 'change_me' is rejected", res.status === 401, `got ${res.status}`);
  }

  // ── V3: plaintext password comparison ─────────────────────────────────────
  {
    const pw = require("../src/security/passwordPolicy");
    check("V3", "plaintext stored value never authenticates",
      (await pw.verifyPassword("123456", "123456")) === false);
    check("V3", "non-bcrypt hash never authenticates",
      (await pw.verifyPassword("secret", "$1$md5$something")) === false);
    check("V3", "empty stored hash never authenticates",
      (await pw.verifyPassword("", "")) === false);

    const src = codeOnly(readSrc("services/authService.js"));
    check("V3", "no === comparison against a stored password",
      !/(rawPassword|password)\s*===\s*(storedPassword|storedHash|user\.password)/.test(src));
  }

  // ── V4: CLIENT_STATIC_PASSWORD shared across every client account ─────────
  {
    const consumers = ["services/authService.js", "services/companyService.js"];
    const offenders = consumers.filter((f) => /CLIENT_STATIC_PASSWORD/.test(codeOnly(readSrc(f))));
    check("V4", "no service reads CLIENT_STATIC_PASSWORD", offenders.length === 0, offenders.join(", "));

    // The old export is a throwing getter so a missed call site fails loudly
    // rather than quietly reintroducing a shared credential.
    let threw = false;
    try {
      // eslint-disable-next-line no-unused-expressions
      require("../src/config/demoUsers").CLIENT_STATIC_PASSWORD;
    } catch { threw = true; }
    check("V4", "reading CLIENT_STATIC_PASSWORD throws", threw);

    const pw = require("../src/security/passwordPolicy");
    check("V4", "'123456' fails the password policy", pw.validatePassword("123456").valid === false);
  }

  // ── V5: quickBooksAuth allowlist bypass ───────────────────────────────────
  {
    // Every one of these was served with NO authentication because its path was
    // absent from the hardcoded qbPaths array.
    const previouslyOpen = [
      { method: "PUT", path: "/api/customers/00000000-0000-0000-0000-000000000001" },
      { method: "GET", path: "/api/auth/status" },
      { method: "GET", path: "/api/auth/disconnect" },
      { method: "POST", path: "/api/auth/transfer-confirm" },
      { method: "GET", path: "/tax-profit-and-loss" },
    ];
    for (const route of previouslyOpen) {
      const res = await request(server, {
        method: route.method,
        path: route.path,
        headers: { "content-type": "application/json" },
        body: route.method === "GET" ? null : "{}",
      });
      check("V5", `${route.method} ${route.path} requires auth`,
        res.status === 401, `got ${res.status}`);
    }

    // The OAuth callback must stay reachable — Intuit calls it with no token.
    const qb = require("../src/middleware/quickbooksAuth");
    check("V5", "guard is derived from the router, not a hardcoded path list",
      typeof qb.guardFinancialRouter === "function");
  }

  // ── V6: CORS allowed any *.vercel.app with credentials ────────────────────
  {
    for (const origin of ["https://evil.vercel.app", "https://attacker.vercel.app",
                          "https://centurium.com.evil.com", "http://app.example.com"]) {
      const res = await request(server, { path: "/health", headers: { origin } });
      const allowed = res.headers["access-control-allow-origin"];
      check("V6", `origin ${origin} is not allowed`,
        res.status === 403 || !allowed, `status ${res.status}, acao=${allowed}`);
    }
    const ok = await request(server, { path: "/health", headers: { origin: "https://app.example.com" } });
    check("V6", "allowlisted origin still works",
      ok.headers["access-control-allow-origin"] === "https://app.example.com");

    const src = codeOnly(readSrc("app.js"));
    check("V6", "no wildcard vercel.app pattern remains", !/vercel\.app/.test(src));
  }

  // ── V7: no Row Level Security on any table ────────────────────────────────
  {
    const migration = fs.readFileSync(
      path.join(__dirname, "..", "sql", "migrations", "090_enable_row_level_security.sql"), "utf8");
    check("V7", "migration enables RLS", /ENABLE ROW LEVEL SECURITY/.test(migration));
    check("V7", "migration forces RLS (applies to the table owner too)",
      /FORCE\s+ROW LEVEL SECURITY/.test(migration));
    check("V7", "migration revokes anon/authenticated grants",
      /REVOKE ALL ON ALL TABLES\s+IN SCHEMA public FROM anon, authenticated/.test(migration));
    check("V7", "migration covers future tables via default privileges",
      /ALTER DEFAULT PRIVILEGES/.test(migration));
    check("V7", "migration self-verifies and raises on any unprotected table",
      /RAISE EXCEPTION 'RLS is not enabled on/.test(migration));
  }

  // ── V8: tokens accepted from query string and 3 custom headers ────────────
  {
    const tok = require("../src/security/tokens");
    check("V8", "?token= is not read", tok.extractBearerToken({ headers: {}, query: { token: "x" } }) === null);
    check("V8", "?access_token= is not read",
      tok.extractBearerToken({ headers: {}, query: { access_token: "x" } }) === null);
    for (const header of ["x-access-token", "x-auth-token", "x-token"]) {
      check("V8", `${header} header is not read`,
        tok.extractBearerToken({ headers: { [header]: "x" } }) === null);
    }
    check("V8", "Authorization: Bearer still works",
      tok.extractBearerToken({ headers: { authorization: "Bearer abc" } }) === "abc");

    const valid = tok.signAccessToken({ userId: "u1", sessionId: "s1" });
    const viaQuery = await request(server, { path: `/auth/me?token=${valid}` });
    check("V8", "a VALID token in the query string is still rejected",
      viaQuery.status === 401, `got ${viaQuery.status}`);
  }

  // ── V9: rejectUnauthorized: false (12 occurrences) ────────────────────────
  {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name))
        : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(path.join("db", "pgPool.js")))
      .filter((f) => /rejectUnauthorized:\s*false/.test(codeOnly(fs.readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f));
    check("V9", "no TLS bypass outside the reviewed pool factory",
      offenders.length === 0, offenders.join(", "));

    // Production default must verify certificates.
    const { buildSslOptions } = require("../src/db/pgPool");
    const remote = buildSslOptions("postgresql://u:p@db.example.com:5432/x");
    check("V9", "remote connections verify the certificate by default",
      remote && remote.rejectUnauthorized === true, JSON.stringify(remote));
    check("V9", "local connections skip TLS (not reachable by an attacker)",
      buildSslOptions("postgresql://u:p@localhost:5432/x") === false);
  }

  // ── V10: logout was a no-op 204 ───────────────────────────────────────────
  {
    const src = codeOnly(readSrc("controllers/auth.js"));
    check("V10", "logout revokes the server-side session",
      /revokeSession\(\s*req\.sessionId/.test(src));
    check("V10", "logout clears the refresh cookie", /clearRefreshCookie\(res\)/.test(src));
    check("V10", "logout-all revokes every session for the user",
      /revokeAllUserSessions\(\s*req\.user\.id/.test(src));

    const sessionService = require("../src/services/sessionService");
    for (const fn of ["revokeSession", "revokeAllUserSessions", "revokeFamily"]) {
      check("V10", `sessionService.${fn} exists`, typeof sessionService[fn] === "function");
    }

    // Logout itself must be authenticated, or it becomes a way to sign others out.
    const res = await request(server, { method: "POST", path: "/auth/logout" });
    check("V10", "logout requires authentication", res.status === 401, `got ${res.status}`);
  }

  // ── V11: 200 MB body parsed before authentication ─────────────────────────
  {
    const routeSrc = readSrc("routes/uploads.js");
    const authAt = routeSrc.indexOf("requireAuth");
    const rawAt = routeSrc.indexOf("express.raw");
    check("V11", "requireAuth is mounted before the body parser",
      authAt > -1 && rawAt > -1 && authAt < rawAt, `auth@${authAt} raw@${rawAt}`);
    check("V11", "the 200mb literal is gone", !/200mb/i.test(routeSrc));
    check("V11", "the limit comes from configuration",
      /config\.UPLOAD_MAX_BYTES/.test(routeSrc));

    const { config } = require("../src/config/env");
    // The original vulnerability was buffering a large body BEFORE auth ran —
    // fixed structurally above (requireAuth precedes express.raw()), so an
    // unauthenticated caller can never trigger a large allocation regardless of
    // this number. The cap itself was raised to 200 MB (2026-08-07) for
    // legitimate large financial exports; this just pins it to the configured
    // hard ceiling (env.js intVar bounds) rather than an arbitrary vuln-era value.
    check("V11", "upload cap is at most the configured hard ceiling (500 MB)",
      config.UPLOAD_MAX_BYTES <= 500 * 1024 * 1024, String(config.UPLOAD_MAX_BYTES));

    // An unauthenticated upload is refused without the body being buffered.
    const res = await request(server, {
      method: "POST", path: "/uploads",
      headers: { "content-type": "application/octet-stream", "x-file-name": "a.pdf" },
      body: "x".repeat(4096),
    });
    check("V11", "unauthenticated upload is rejected", res.status === 401, `got ${res.status}`);

    const presign = await request(server, {
      method: "POST", path: "/uploads/presign",
      headers: { "content-type": "application/json" }, body: "{}",
    });
    check("V11", "presign endpoint requires auth", presign.status === 401, `got ${presign.status}`);
  }

  // ── V12: orphaned uploads readable by any authenticated user ──────────────
  {
    const src = codeOnly(readSrc("controllers/uploads.js"));
    // The bug was `upload.uploaded_by && String(...) !== String(...)` — a NULL
    // uploader short-circuited the check away. It must now fail closed.
    check("V12", "no truthiness short-circuit on uploaded_by",
      !/upload\.uploaded_by\s*&&\s*String\(/.test(src));
    check("V12", "comparison coerces NULL so it cannot be skipped",
      /String\(upload\.uploaded_by\s*\|\|\s*""\)\s*!==\s*String\(req\.user\?\.id\s*\|\|\s*""\)/.test(src));
    check("V12", "download response denies generically",
      /error:\s*"Access denied",\s*code:\s*"FORBIDDEN"/.test(src));
  }

  // ── V13: 403 body echoed the caller's role ────────────────────────────────
  {
    const authSrc = codeOnly(readSrc("middleware/auth.js"));
    const rbacSrc = codeOnly(readSrc("middleware/rbac.js"));
    check("V13", "requireRole does not echo the role back",
      !/Your role:|Required role:/.test(authSrc));
    check("V13", "auth 403 body is generic",
      /error:\s*"Access denied",\s*code:\s*"FORBIDDEN"/.test(authSrc));
    check("V13", "rbac 403 body is generic",
      /error:\s*"Access denied",\s*code:\s*"FORBIDDEN"/.test(rbacSrc));
    // The role is still recorded server-side for the audit trail.
    check("V13", "denial is still audited", /authorization_denied/.test(rbacSrc));

    const res = await request(server, { path: "/auth/me" });
    check("V13", "401 body leaks nothing about the account",
      !/role|admin|broker|buyer/i.test(res.body), res.body.slice(0, 120));
  }

  // ── V14: OTP endpoint returned 409 for an existing account ────────────────
  {
    const src = codeOnly(readSrc("controllers/auth.js"));
    const otpFn = src.slice(src.indexOf("const sendVerificationOtp"),
                            src.indexOf("const verifyVerificationOtp"));
    check("V14", "sendVerificationOtp never returns 409", !/status\(409\)/.test(otpFn));
    check("V14", "sendVerificationOtp never says the account exists",
      !/already exists/i.test(otpFn));
    check("V14", "response is identical whether or not the account exists",
      /If this address can be registered/.test(otpFn));

    const forgot = src.slice(src.indexOf("const forgotPassword"), src.indexOf("const verifyResetOtp"));
    check("V14", "forgot-password stays generic",
      /If an account exists for this email/.test(forgot));
    check("V14", "login failure does not distinguish unknown from wrong password",
      /Invalid email or password/.test(src) && !/no such (user|account)/i.test(src));

    // Timing equalisation is the other half of enumeration defence.
    const pw = require("../src/security/passwordPolicy");
    check("V14", "burnPasswordTiming exists for the unknown-account path",
      typeof pw.burnPasswordTiming === "function");
  }

  // ── V16: dev-only OTP surfacing must never reach production ───────────────
  {
    const src = codeOnly(readSrc("controllers/auth.js"));
    check("V16", "OTP surfacing is guarded by IS_PRODUCTION",
      /function surfaceOtpInDevelopment[\s\S]{0,400}?if \(config\.IS_PRODUCTION\) return;/.test(src));
    check("V16", "OTP is never placed in an HTTP response body",
      !/res\.json\([^)]*\botp\b/.test(src));
    check("V16", "OTP is never written to the structured logger",
      !/logger\.(info|warn|error|debug)\([^)]*\botp\b/i.test(src));
    check("V16", "OTP is only surfaced when delivery actually failed",
      /if \(!emailResult\.sent\) \{[\s\S]{0,200}?surfaceOtpInDevelopment/.test(src));

    // Prove the guard at runtime, not just by reading the source.
    const { config } = require("../src/config/env");
    check("V16", "guard reads a validated boot-time value",
      typeof config.IS_PRODUCTION === "boolean");

    const otpSrc = codeOnly(readSrc("services/otpService.js"));
    check("V16", "otpService never logs the OTP itself",
      !/console\.log\([^)]*\botp\b(?!Hash)/i.test(otpSrc) &&
      !/logger\.\w+\([^)]*\botp\b(?!Hash)[^)]*\$\{otp\}/i.test(otpSrc));
    check("V16", "otpService stores only a hash",
      /otpHash\s*=\s*await bcrypt\.hash\(otp/.test(otpSrc));
  }

  // ── V15: password reset auto-issued a session ─────────────────────────────
  {
    const src = codeOnly(readSrc("controllers/auth.js"));
    const resetFn = src.slice(src.indexOf("const resetPassword ="), src.indexOf("module.exports"));
    check("V15", "reset does not sign a token", !/signToken|signAccessToken/.test(resetFn));
    check("V15", "reset does not return a session", !/sessionResponse\(/.test(resetFn));
    check("V15", "reset clears any existing refresh cookie", /clearRefreshCookie\(res\)/.test(resetFn));
    check("V15", "reset directs the user to sign in", /Please sign in/.test(resetFn));

    const authService = codeOnly(readSrc("services/authService.js"));
    check("V15", "reset revokes every existing session",
      /revokeAllUserSessions\(user\.id,\s*"password_change"\)/.test(authService));
    check("V15", "reset bumps token_version, killing live access tokens",
      /token_version:\s*\(user\.token_version\s*\?\?\s*0\)\s*\+\s*1/.test(authService));
  }

  server.close();

  // ── Report ────────────────────────────────────────────────────────────────
  const TITLES = {
    V1: "Gmail app password committed",
    V2: 'JWT_SECRET || "change_me"',
    V3: "Plaintext password comparison",
    V4: 'CLIENT_STATIC_PASSWORD = "123456"',
    V5: "quickBooksAuth allowlist bypass",
    V6: "CORS *.vercel.app + credentials",
    V7: "No RLS anywhere",
    V8: "?token= + custom headers accepted",
    V9: "rejectUnauthorized: false x12",
    V10: "Logout was a no-op 204",
    V11: "200 MB body parsed before auth",
    V12: "Orphaned uploads readable by anyone",
    V13: "403 echoed the caller's role",
    V14: "OTP endpoint returned 409",
    V15: "Reset code auto-issued a session",
    V16: "Dev-only OTP surfacing (must never hit prod)",
  };

  console.log("\n=== VULNERABILITY REGRESSION RESULTS ===\n");
  let failed = 0;
  for (const id of Object.keys(TITLES)) {
    const group = results.filter((r) => r.id === id);
    const bad = group.filter((r) => !r.pass);
    failed += bad.length;
    console.log(`${bad.length === 0 ? "\x1b[32m[x]\x1b[0m" : "\x1b[31m[ ]\x1b[0m"} ${id}  ${TITLES[id]}  (${group.length - bad.length}/${group.length})`);
    for (const r of bad) console.log(`      \x1b[31mFAIL\x1b[0m ${r.name} — ${r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} assertions passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("REGRESSION SUITE CRASHED:", error);
  process.exit(2);
});
