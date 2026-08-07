#!/usr/bin/env node
"use strict";

/**
 * Verifies the database TLS chain end to end.
 *
 *   npm run verify:db-tls
 *
 * Reports, for the configured DATABASE_URL:
 *   • the certificate chain the server actually presents
 *   • whether it verifies against our configured trust anchors
 *   • whether the bundled Supabase root matches its pinned fingerprint
 *   • whether the root the server chains to is the one we bundled
 *
 * Run this after changing DATABASE_URL, rotating a CA, or whenever a
 * SELF_SIGNED_CERT_IN_CHAIN error appears. It answers "who am I actually
 * trusting?" without starting the application.
 */

require("dotenv").config();

const tls = require("tls");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");

const {
  buildSslOptions,
  describeSslPosture,
  loadSupabaseCa,
  SUPABASE_ROOT_CA_FINGERPRINT,
  SUPABASE_CA_PATH,
} = require("../src/db/pgPool");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const bad = (m) => console.log(`${RED}✗${RESET} ${m}`);
const warn = (m) => console.log(`${YELLOW}!${RESET} ${m}`);

/**
 * Postgres does not speak TLS immediately — the client sends an 8-byte
 * SSLRequest and the server replies with a single 'S' before the handshake.
 */
function pgStartTls(host, port, tlsOptions) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4); // SSLRequest magic
      socket.write(request);
    });

    socket.once("data", (reply) => {
      if (reply.toString() !== "S") {
        socket.destroy();
        return reject(new Error(`server declined TLS (replied '${reply.toString()}')`));
      }
      const secured = tls.connect({ socket, servername: host, ...tlsOptions }, () =>
        resolve(secured)
      );
      secured.on("error", reject);
    });

    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out after 20s"));
    }, 20000).unref();
  });
}

function chainOf(socket) {
  const chain = [];
  const seen = new Set();
  let cert = socket.getPeerCertificate(true);
  while (cert && cert.fingerprint256 && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256);
    chain.push(cert);
    if (cert.issuerCertificate === cert) break;
    cert = cert.issuerCertificate;
  }
  return chain;
}

(async () => {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    bad("DATABASE_URL is not set — nothing to verify.");
    process.exit(1);
  }

  let url;
  try {
    url = new URL(dsn);
  } catch {
    bad("DATABASE_URL is not a parseable URL.");
    process.exit(1);
  }

  const host = url.hostname;
  const port = Number(url.port || 5432);

  console.log(`\nHost    : ${host}:${port}`);
  console.log(`Posture : ${describeSslPosture(dsn)}\n`);

  let failures = 0;

  // ── 1. Bundled CA integrity ───────────────────────────────────────────────
  if (fs.existsSync(SUPABASE_CA_PATH)) {
    const pem = fs.readFileSync(SUPABASE_CA_PATH, "utf8");
    const cert = new crypto.X509Certificate(pem);
    if (cert.fingerprint256 === SUPABASE_ROOT_CA_FINGERPRINT) {
      ok(`Bundled CA matches pinned fingerprint (expires ${cert.validTo})`);
    } else {
      bad("Bundled CA does NOT match the pinned fingerprint — it will not be trusted.");
      console.log(`    on disk: ${cert.fingerprint256}`);
      console.log(`    pinned : ${SUPABASE_ROOT_CA_FINGERPRINT}`);
      failures += 1;
    }
    if (new Date(cert.validTo).getTime() < Date.now()) {
      bad(`Bundled CA EXPIRED on ${cert.validTo}`);
      failures += 1;
    }
  } else {
    warn("No bundled Supabase CA present (fine for non-Supabase hosts).");
  }

  const sslOptions = buildSslOptions(dsn);

  if (sslOptions === false) {
    warn("Loopback connection — TLS not used. Nothing further to verify.");
    process.exit(0);
  }

  // ── 2. What the server presents ───────────────────────────────────────────
  let inspect;
  try {
    inspect = await pgStartTls(host, port, { rejectUnauthorized: false });
  } catch (error) {
    bad(`Could not reach the server: ${error.message}`);
    process.exit(1);
  }

  const chain = chainOf(inspect);
  console.log("\n  Certificate chain presented by the server:");
  chain.forEach((cert, depth) => {
    console.log(`    [${depth}] ${cert.subject.CN || "(no CN)"}`);
    console.log(`        issuer  ${cert.issuer.CN || "(no CN)"}`);
    console.log(`        expires ${cert.valid_to}`);
  });
  const serverRoot = chain[chain.length - 1];
  inspect.end();

  // ── 3. Does it verify under our real configuration? ───────────────────────
  console.log("");
  let verified;
  try {
    verified = await pgStartTls(host, port, {
      ca: sslOptions.ca,
      rejectUnauthorized: true,
      minVersion: sslOptions.minVersion,
    });
    ok(`Chain VERIFIES under the application's trust configuration`);
    ok(`Hostname matches the certificate (verify-full)`);
    console.log(`    protocol: ${verified.getProtocol()}`);
    console.log(`    cipher  : ${verified.getCipher().name}`);
    verified.end();
  } catch (error) {
    bad(`Verification FAILED: ${error.message}`);
    console.log(
      "\n    The server's root is not among our trust anchors. Do NOT set\n" +
        "    DATABASE_SSL_REJECT_UNAUTHORIZED=false. Instead supply the correct CA\n" +
        "    via DATABASE_CA_CERT, or restore backend/certs/."
    );
    failures += 1;
  }

  // ── 4. Is the server's root the one we pinned? ────────────────────────────
  const bundled = loadSupabaseCa();
  if (bundled && serverRoot) {
    const bundledFp = new crypto.X509Certificate(bundled).fingerprint256;
    if (bundledFp === serverRoot.fingerprint256) {
      ok("Server's root is exactly the bundled, pinned CA");
    } else {
      warn("Server chains to a root other than the bundled CA (using system trust).");
    }
  }

  console.log("");
  if (failures > 0) {
    bad(`${failures} problem(s) found.`);
    process.exit(1);
  }
  ok("Database TLS is correctly configured and fully verified.");
  process.exit(0);
})().catch((error) => {
  bad(`Unexpected: ${error.message}`);
  process.exit(1);
});
