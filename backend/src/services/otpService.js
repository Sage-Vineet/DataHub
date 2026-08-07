"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { supabase } = require("../db");
const { signActionToken } = require("../security/tokens");
const logger = require("../security/logger");
const { config } = require("../config/env");

const OTP_EXPIRY_MS = 10 * 60 * 1000;  // 10 minutes
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const RESEND_WINDOW_MS = 10 * 60 * 1000;  // per 10-minute window
const VERIFICATION_TOKEN_TTL_SECONDS = 15 * 60;

// ── In-memory fallback ────────────────────────────────────────────────────────
// Used automatically when the email_verifications Supabase table doesn't exist
// yet (development). Run migration 040 in production for proper persistence.
const _mem = new Map();

function _memKey(email, purpose) {
  return `${purpose}:${email.toLowerCase()}`;
}

function _memGetActive(email, purpose) {
  const r = _mem.get(_memKey(email, purpose));
  if (!r || r.verified || r.expiresAt < Date.now()) return null;
  return r;
}

function _memCreate(email, purpose, otpHash, currentResendCount) {
  _mem.set(_memKey(email, purpose), {
    id: `mem-${Date.now()}`,
    otp_hash: otpHash,
    attempts: 0,
    resend_count: currentResendCount,
    verified: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + OTP_EXPIRY_MS,
  });
}

function _memResendCount(email, purpose) {
  const r = _mem.get(_memKey(email, purpose));
  return r ? (r.resend_count || 0) : 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _isTableMissing(err, status) {
  if (!err) return false;
  const msg = String(err?.message || err?.details || "").toLowerCase();
  if (err?.code === "42P01" || err?.code === "42703" || err?.code === "PGRST204") return true;
  if (msg.includes("does not exist")) return true;
  if (msg.includes("relation \"email_verifications\"")) return true;
  if (msg.includes("could not find") && msg.includes("column")) return true;
  // PostgREST can return a bare 400 with an empty message when its schema
  // cache doesn't recognize a queried column (e.g. `purpose`, before
  // migration 087 has been applied to this environment's DB) — treat that
  // the same as a missing table/column and fall back to the in-memory store.
  if (status === 400 && !msg) return true;
  return false;
}

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// ── Supabase operations (each falls back gracefully) ─────────────────────────
async function _getResendCount(email, purpose) {
  try {
    const since = new Date(Date.now() - RESEND_WINDOW_MS).toISOString();
    const { count, error, status } = await supabase
      .from("email_verifications")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .eq("purpose", purpose)
      .gte("created_at", since);
    if (error) {
      if (_isTableMissing(error, status)) return _memResendCount(email, purpose);
      throw error;
    }
    return count || 0;
  } catch (err) {
    if (_isTableMissing(err)) return _memResendCount(email, purpose);
    throw err;
  }
}

async function _storeOtp(email, purpose, otpHash, resendCount) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);

  // Clear previous unverified records for this email + purpose
  try {
    await supabase
      .from("email_verifications")
      .delete()
      .eq("email", email)
      .eq("purpose", purpose)
      .eq("verified", false);
  } catch { /* non-fatal — proceed with insert */ }

  try {
    const { error, status } = await supabase.from("email_verifications").insert({
      email,
      purpose,
      otp_hash: otpHash,
      attempts: 0,
      resend_count: resendCount,
      verified: false,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    if (error) {
      if (_isTableMissing(error, status)) {
        _memCreate(email, purpose, otpHash, resendCount);
        console.warn(
          "[OTP Service] email_verifications table not found — using in-memory store. " +
          "Run migration 040_email_verifications.sql for production persistence."
        );
        return;
      }
      throw error;
    }
  } catch (err) {
    if (_isTableMissing(err)) {
      _memCreate(email, purpose, otpHash, resendCount);
      console.warn("[OTP Service] Falling back to in-memory OTP store.");
      return;
    }
    throw err;
  }
}

async function _getActiveRecord(email, purpose) {
  try {
    const { data, error, status } = await supabase
      .from("email_verifications")
      .select("*")
      .eq("email", email)
      .eq("purpose", purpose)
      .eq("verified", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (_isTableMissing(error, status) || error.code === "PGRST116") return _memGetActive(email, purpose);
      throw error;
    }
    return data || _memGetActive(email, purpose);
  } catch (err) {
    if (_isTableMissing(err)) return _memGetActive(email, purpose);
    throw err;
  }
}

async function _incrementAttempts(recordId, currentAttempts, email, purpose) {
  if (String(recordId).startsWith("mem-")) {
    const r = _mem.get(_memKey(email, purpose));
    if (r) r.attempts = currentAttempts + 1;
    return;
  }
  try {
    await supabase
      .from("email_verifications")
      .update({ attempts: currentAttempts + 1 })
      .eq("id", recordId);
  } catch {
    const r = _mem.get(_memKey(email, purpose));
    if (r) r.attempts = currentAttempts + 1;
  }
}

async function _markVerified(recordId, email, purpose) {
  if (String(recordId).startsWith("mem-")) {
    const r = _mem.get(_memKey(email, purpose));
    if (r) { r.verified = true; r.verifiedAt = Date.now(); }
    return;
  }
  try {
    await supabase
      .from("email_verifications")
      .update({ verified: true, verified_at: new Date().toISOString() })
      .eq("id", recordId);
  } catch {
    const r = _mem.get(_memKey(email, purpose));
    if (r) { r.verified = true; r.verifiedAt = Date.now(); }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates and stores a new 6-digit OTP for the given email.
 * Enforces max 3 send requests per 10-minute window.
 * Returns the plain-text OTP (to be emailed — never stored plain).
 *
 * @param {string} email
 * @param {string} [purpose] - "email_verification" (default, broker signup) or "password_reset"
 * @returns {Promise<string>} plain-text OTP
 */
async function sendOtp(email, purpose = "email_verification") {
  const normalized = email.toLowerCase();

  const count = await _getResendCount(normalized, purpose);
  if (count >= MAX_RESENDS) {
    const err = new Error(
      "Too many verification requests. Please wait 10 minutes before trying again."
    );
    err.status = 429;
    throw err;
  }

  const otp = generateOtp();
  // Hashed at the configured work factor. Note that a 6-digit OTP has only
  // 10^6 candidates, so hashing alone does not make a leaked table safe — the
  // real protections are the 10-minute expiry and the 5-attempt cap below.
  const otpHash = await bcrypt.hash(otp, config.BCRYPT_ROUNDS);
  await _storeOtp(normalized, purpose, otpHash, count + 1);

  // The OTP itself is never logged — it is a live credential until verified.
  logger.info("otp_created", { purpose, attemptCount: count + 1 });
  return otp;
}

/**
 * Verifies the 6-digit OTP for the given email.
 * Enforces max 5 attempts and 10-minute expiry.
 * On success, returns a signed 15-minute verification JWT.
 *
 * @param {string} email
 * @param {string} otp
 * @param {string} [purpose] - "email_verification" (default, broker signup) or "password_reset"
 * @returns {Promise<{ verified: true, verificationToken: string }>}
 */
async function verifyOtp(email, otp, purpose = "email_verification") {
  const normalized = email.toLowerCase();

  const record = await _getActiveRecord(normalized, purpose);
  if (!record) {
    const err = new Error(
      "Verification code has expired or was not found. Please request a new code."
    );
    err.status = 400;
    throw err;
  }

  const attempts = record.attempts ?? 0;
  if (attempts >= MAX_ATTEMPTS) {
    const err = new Error(
      "Too many failed attempts. Please request a new verification code."
    );
    err.status = 429;
    throw err;
  }

  await _incrementAttempts(record.id, attempts, normalized, purpose);

  const isValid = await bcrypt.compare(String(otp).trim(), record.otp_hash);

  if (!isValid) {
    const remaining = MAX_ATTEMPTS - attempts - 1;
    const err = new Error(
      remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
        : "Too many failed attempts. Please request a new verification code."
    );
    err.status = 400;
    throw err;
  }

  await _markVerified(record.id, normalized, purpose);

  // Issued through the central token service: pinned algorithm, validated
  // secret (no "change_me" fallback), and an explicit `typ` claim so a
  // verification token can never be replayed as an access or refresh token.
  const verificationToken = signActionToken({
    purpose,
    email: normalized,
    ttlSeconds: VERIFICATION_TOKEN_TTL_SECONDS,
  });

  logger.info("otp_verified", { purpose });
  return { verified: true, verificationToken };
}

module.exports = { sendOtp, verifyOtp };
