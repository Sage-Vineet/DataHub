process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "unit-test-access-secret-with-entropy-abcdefghij";
process.env.JWT_REFRESH_SECRET = "unit-test-refresh-secret-with-entropy-klmnopqrs";
process.env.DATA_ENCRYPTION_KEY = require("crypto").randomBytes(32).toString("base64");

const B = require("path").join(__dirname, "../src/") + require("path").sep;
const results = [];
const t = (name, fn) => {
  try {
    const r = fn();
    results.push({ name, pass: r === true, detail: r === true ? "" : String(r) });
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
  }
};
const ta = async (name, fn) => {
  try {
    const r = await fn();
    results.push({ name, pass: r === true, detail: r === true ? "" : String(r) });
  } catch (e) {
    results.push({ name, pass: false, detail: e.message });
  }
};

(async () => {
  // ── Password policy ───────────────────────────────────────────────────────
  const pw = require(B + "security/passwordPolicy");

  t("rejects <5 chars", () => pw.validatePassword("Sh0!").valid === false);
  t("rejects no uppercase", () => pw.validatePassword("alllowercase1!").valid === false);
  t("rejects no lowercase", () => pw.validatePassword("ALLUPPERCASE1!").valid === false);
  t("rejects no digit", () => pw.validatePassword("NoDigitsHere!!").valid === false);
  t("rejects no special", () => pw.validatePassword("NoSpecials1234").valid === false);
  t("rejects common password", () => pw.validatePassword("Password123!").valid === false);
  t("rejects leet-ed common", () => pw.validatePassword("P@ssw0rd123!").valid === false);
  t("rejects long-but-weak", () => pw.validatePassword("Aaaaaaaaaaaa1!").valid === false);
  t("rejects sequential run", () => pw.validatePassword("Abcdefgh123!X").valid === false);
  t("rejects password containing email local part", () =>
    pw.validatePassword("Aditya!Str0ngPw", { email: "aditya@x.com" }).valid === false);
  t("accepts a strong password", () => {
    const r = pw.validatePassword("Tr0ubadour&Kn!ght");
    return r.valid === true || r.errors.join(",");
  });
  t("generated password satisfies policy", () => {
    for (let i = 0; i < 50; i += 1) {
      const g = pw.generateStrongPassword(20);
      const r = pw.validatePassword(g);
      if (!r.valid) return `${g}: ${r.errors.join(",")}`;
    }
    return true;
  });

  await ta("bcrypt round-trip verifies", async () => {
    const h = await pw.hashPassword("Tr0ubadour&Kn!ght");
    return (await pw.verifyPassword("Tr0ubadour&Kn!ght", h)) === true;
  });
  await ta("wrong password fails", async () => {
    const h = await pw.hashPassword("Tr0ubadour&Kn!ght");
    return (await pw.verifyPassword("wrong", h)) === false;
  });
  await ta("CRITICAL: plaintext stored value never matches", async () =>
    (await pw.verifyPassword("123456", "123456")) === false);
  await ta("CRITICAL: null hash never matches", async () =>
    (await pw.verifyPassword("anything", null)) === false);
  await ta("bcrypt cost is >= 12", async () => {
    const h = await pw.hashPassword("Tr0ubadour&Kn!ght");
    return Number(h.split("$")[2]) >= 12 || h;
  });

  // ── Tokens ────────────────────────────────────────────────────────────────
  const tok = require(B + "security/tokens");
  const jwt = require("jsonwebtoken");

  const access = tok.signAccessToken({ userId: "u1", sessionId: "s1", role: "admin" });
  t("access token verifies", () => tok.verifyAccessToken(access).sub === "u1");
  t("CRITICAL: access token rejected as refresh", () => {
    try { tok.verifyRefreshToken(access); return "accepted!"; } catch { return true; }
  });
  const { token: refresh } = tok.signRefreshToken({ userId: "u1", sessionId: "s1", familyId: "f1" });
  t("CRITICAL: refresh token rejected as access", () => {
    try { tok.verifyAccessToken(refresh); return "accepted!"; } catch { return true; }
  });
  t("CRITICAL: alg=none rejected", () => {
    const none = jwt.sign({ sub: "u1", typ: "access", iss: "datahub-api", aud: "datahub-app" },
      "", { algorithm: "none" });
    try { tok.verifyAccessToken(none); return "accepted!"; } catch { return true; }
  });
  t("CRITICAL: wrong issuer rejected", () => {
    const bad = jwt.sign({ sub: "u1", typ: "access", iss: "evil", aud: "datahub-app" },
      process.env.JWT_SECRET, { algorithm: "HS256" });
    try { tok.verifyAccessToken(bad); return "accepted!"; } catch { return true; }
  });
  t("expired token rejected with EXPIRED code", () => {
    const exp = jwt.sign({ sub: "u1", typ: "access", iss: "datahub-api", aud: "datahub-app" },
      process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: -60 });
    try { tok.verifyAccessToken(exp); return "accepted!"; } catch (e) { return e.code === "EXPIRED" || e.code; }
  });
  t("action token purpose is enforced", () => {
    const a = tok.signActionToken({ purpose: "email_verification", email: "x@y.com" });
    try { tok.verifyActionToken(a, "password_reset"); return "accepted!"; } catch { return true; }
  });
  t("CRITICAL: query-string token not extracted", () =>
    tok.extractBearerToken({ headers: {}, query: { token: "abc" } }) === null);
  t("CRITICAL: x-access-token not extracted", () =>
    tok.extractBearerToken({ headers: { "x-access-token": "abc" } }) === null);
  t("bearer header is extracted", () =>
    tok.extractBearerToken({ headers: { authorization: "Bearer abc" } }) === "abc");

  // ── Crypto ────────────────────────────────────────────────────────────────
  const cr = require(B + "security/crypto");
  t("AES-GCM round-trip", () => cr.decrypt(cr.encrypt("secret-value")) === "secret-value");
  t("ciphertext differs each time (random IV)", () =>
    cr.encrypt("same") !== cr.encrypt("same"));
  t("CRITICAL: tampered ciphertext throws", () => {
    const c = cr.encrypt("secret-value");
    const parts = c.split(":");
    const buf = Buffer.from(parts[3], "base64url");
    buf[0] ^= 0xff;
    parts[3] = buf.toString("base64url");
    try { cr.decrypt(parts.join(":")); return "accepted tampered data!"; } catch { return true; }
  });
  t("safeEqual works", () => cr.safeEqual("abc", "abc") === true && cr.safeEqual("abc", "abd") === false);

  // ── File upload ───────────────────────────────────────────────────────────
  const fu = require(B + "security/fileUpload");
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 0x20)]);
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(200, 0)]);

  t("valid PDF accepted", () => {
    const r = fu.validateUpload({ buffer: pdf, originalname: "report.pdf", mimetype: "application/pdf" });
    return r.mimeType === "application/pdf" && /^[0-9a-f-]{36}\.pdf$/.test(r.storedName);
  });
  t("CRITICAL: .exe rejected", () => {
    try { fu.validateUpload({ buffer: exe, originalname: "bad.exe" }); return "accepted!"; }
    catch (e) { return e.code === "FORBIDDEN_EXTENSION" || e.code === "EXECUTABLE_REJECTED" || e.code; }
  });
  t("CRITICAL: exe renamed .pdf rejected by magic bytes", () => {
    try { fu.validateUpload({ buffer: exe, originalname: "invoice.pdf", mimetype: "application/pdf" }); return "accepted!"; }
    catch (e) { return e.code === "EXECUTABLE_REJECTED" || e.code; }
  });
  t("CRITICAL: path traversal in filename stripped/rejected", () => {
    try {
      const r = fu.validateUpload({ buffer: pdf, originalname: "../../../etc/passwd.pdf", mimetype: "application/pdf" });
      return !r.storedName.includes("..") && !r.storedName.includes("/");
    } catch { return true; }
  });
  t("CRITICAL: null-byte filename rejected", () => {
    try { fu.validateUpload({ buffer: pdf, originalname: "a.php\u0000.pdf" }); return "accepted!"; }
    catch (e) { return e.code === "NULL_BYTE" || e.code; }
  });
  t("CRITICAL: double extension .php.pdf rejected", () => {
    try { fu.validateUpload({ buffer: pdf, originalname: "shell.php.pdf", mimetype: "application/pdf" }); return "accepted!"; }
    catch (e) { return e.code === "FORBIDDEN_EXTENSION" || e.code; }
  });
  t("CRITICAL: SVG rejected (script execution)", () => {
    try { fu.validateUpload({ buffer: Buffer.from("<svg onload=alert(1)>"), originalname: "x.svg" }); return "accepted!"; }
    catch (e) { return e.code === "FORBIDDEN_EXTENSION" || e.code; }
  });
  t("CRITICAL: PDF with /JavaScript rejected", () => {
    const evil = Buffer.concat([Buffer.from("%PDF-1.7\n/JavaScript (app.alert(1))\n"), Buffer.alloc(100, 0x20)]);
    try { fu.validateUpload({ buffer: evil, originalname: "x.pdf", mimetype: "application/pdf" }); return "accepted!"; }
    catch (e) { return e.code === "ACTIVE_CONTENT" || e.code; }
  });
  t("CRITICAL: macro-bearing xlsx rejected", () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("xl/vbaProject.bin"), Buffer.alloc(100, 0)]);
    try { fu.validateUpload({ buffer: zip, originalname: "book.xlsx", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }); return "accepted!"; }
    catch (e) { return e.code === "ACTIVE_CONTENT" || e.code; }
  });
  t("oversized file rejected", () => {
    try { fu.validateUpload({ buffer: pdf, originalname: "x.pdf" }, { maxBytes: 10 }); return "accepted!"; }
    catch (e) { return e.code === "FILE_TOO_LARGE" || e.code; }
  });
  t("MIME/extension mismatch rejected", () => {
    try { fu.validateUpload({ buffer: pdf, originalname: "x.pdf", mimetype: "image/png" }); return "accepted!"; }
    catch (e) { return e.code === "MIME_MISMATCH" || e.code; }
  });
  t("CRITICAL: resolveWithinDirectory blocks traversal", () => {
    try { fu.resolveWithinDirectory("/data/uploads", "../../etc/passwd"); }
    catch { return true; }
    const r = fu.resolveWithinDirectory("/data/uploads", "../../etc/passwd");
    return !r.includes("etc") || r;
  });
  t("CSV formula injection neutralised", () =>
    fu.sanitizeCsvCell("=cmd|'/c calc'!A1").startsWith("'="));

  // ── RBAC ──────────────────────────────────────────────────────────────────
  const rbac = require(B + "middleware/rbac");
  t("admin resolves to admin", () => rbac.resolveRole({ role: "admin" }) === "admin");
  t("broker_primary resolves to manager", () =>
    rbac.resolveRole({ role: "broker", sub_role: "broker_primary" }) === "manager");
  t("buyer_team_member resolves to viewer", () =>
    rbac.resolveRole({ role: "buyer", sub_role: "buyer_team_member" }) === "viewer");
  t("admin is never downgraded by sub_role", () =>
    rbac.resolveRole({ role: "admin", sub_role: "buyer_team_member" }) === "admin");
  t("unknown role defaults to viewer (least privilege)", () =>
    rbac.resolveRole({ role: "nonsense" }) === "viewer");
  t("viewer cannot delete company", () =>
    rbac.can({ role: "buyer", sub_role: "buyer_team_member" }, rbac.PERMISSION.COMPANY_DELETE) === false);
  t("viewer can read reports", () =>
    rbac.can({ role: "buyer", sub_role: "buyer_team_member" }, rbac.PERMISSION.REPORT_READ) === true);
  t("manager inherits viewer+user permissions", () =>
    rbac.can({ role: "broker" }, rbac.PERMISSION.REPORT_READ) === true &&
    rbac.can({ role: "broker" }, rbac.PERMISSION.REPORT_GENERATE) === true &&
    rbac.can({ role: "broker" }, rbac.PERMISSION.REPORT_APPROVE) === true);
  t("manager cannot read the audit log", () =>
    rbac.can({ role: "broker" }, rbac.PERMISSION.SECURITY_AUDIT_READ) === false);
  t("admin can read the audit log", () =>
    rbac.can({ role: "admin" }, rbac.PERMISSION.SECURITY_AUDIT_READ) === true);
  t("null user holds nothing", () => rbac.can(null, rbac.PERMISSION.REPORT_READ) === false);
  t("unknown permission name throws at startup", () => {
    try { rbac.requirePermission("not:a:real:permission"); return "did not throw"; } catch { return true; }
  });

  // ── Logger redaction ──────────────────────────────────────────────────────
  const log = require(B + "security/logger");
  const red = log.redact({
    password: "hunter2",
    refreshToken: "abc",
    api_key: "k",
    connectionString: "postgres://u:p@h/db",
    email: "someone@example.com",
    note: "bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    nested: { client_secret: "s", safe: "ok" },
  });
  t("password redacted", () => red.password === "[REDACTED]");
  t("refreshToken redacted", () => red.refreshToken === "[REDACTED]");
  t("api_key redacted", () => red.api_key === "[REDACTED]");
  t("connection string redacted", () => red.connectionString === "[REDACTED]");
  t("email masked not removed", () => red.email === "s***@example.com");
  t("CRITICAL: JWT in free text redacted", () => !red.note.includes("eyJ") || red.note);
  t("nested secret redacted", () => red.nested.client_secret === "[REDACTED]" && red.nested.safe === "ok");
  t("circular object does not hang", () => {
    const o = { a: 1 }; o.self = o;
    return log.redact(o).self === "[Circular]";
  });

  // ── Input validation ──────────────────────────────────────────────────────
  const val = require(B + "middleware/validate");
  t("CRITICAL: __proto__ stripped from body", () => {
    const parsed = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
    const clean = val.stripDangerousKeys(parsed);
    return !Object.prototype.hasOwnProperty.call(clean, "__proto__") && {}.polluted === undefined && Object.keys(clean).join() === "a";
  });
  t("constructor key stripped", () => {
    const clean = val.stripDangerousKeys({ constructor: { x: 1 }, ok: 2 });
    return clean.ok === 2 && clean.constructor !== undefined && !Object.prototype.hasOwnProperty.call(clean, "constructor");
  });
  t("deep nesting rejected", () => {
    let deep = {}; let cur = deep;
    for (let i = 0; i < 20; i += 1) { cur.n = {}; cur = cur.n; }
    try { val.stripDangerousKeys(deep); return "accepted"; } catch (e) { return e.code === "PAYLOAD_TOO_DEEP" || e.code; }
  });
  t("searchTerm strips PostgREST operators", () => {
    const r = val.schemas.searchTerm.parse("a,b.c(d)*e%f");
    return !/[,.()*%]/.test(r) || r;
  });
  t("email schema normalises case", () =>
    val.schemas.email.parse("  User@Example.COM ") === "user@example.com");
  t("strictObject rejects extra keys", () => {
    const s = val.schemas.strictObject({ a: val.z.string() });
    return s.safeParse({ a: "x", role: "admin" }).success === false;
  });

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("\n=== UNIT TEST RESULTS ===");
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed += 1;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${!r.pass ? `  [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
