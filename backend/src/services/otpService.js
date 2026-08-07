"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { supabase } = require("../db");
const { JWT_SECRET } = require("../config/secrets");

const OTP_EXPIRY_MS = 10 * 60 * 1000;  // 10 minutes
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const RESEND_WINDOW_MS = 10 * 60 * 1000;  // per 10-minute window
const VERIFICATION_TOKEN_TTL = "15m";

// ── In-memory fallback ────────────────────────────────────────────────────────
// Used automatically when the email_verifications Supabase table doesn't exist
// yet (development). Run migration 040 in production for proper persistence.
const _mem = new Map();

function _memKey(email) {
  return email.toLowerCase();
}

function _memGetActive(email) {
  const r = _mem.get(_memKey(email));
  if (!r || r.verified || r.expiresAt < Date.now()) return null;
  return r;
}

function _memCreate(email, otpHash, currentResendCount) {
  _mem.set(_memKey(email), {
    id: `mem-${Date.now()}`,
    otp_hash: otpHash,
    attempts: 0,
    resend_count: currentResendCount,
    verified: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + OTP_EXPIRY_MS,
  });
}

function _memResendCount(email) {
  const r = _mem.get(_memKey(email));
  return r ? (r.resend_count || 0) : 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _isTableMissing(err) {
  const msg = String(err?.message || err?.details || "").toLowerCase();
  return (
    err?.code === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("relation \"email_verifications\"")
  );
}

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// ── Supabase operations (each falls back gracefully) ─────────────────────────
async function _getResendCount(email) {
  try {
    const since = new Date(Date.now() - RESEND_WINDOW_MS).toISOString();
    const { count, error } = await supabase
      .from("email_verifications")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", since);
    if (error) {
      if (_isTableMissing(error)) return _memResendCount(email);
      throw error;
    }
    return count || 0;
  } catch (err) {
    if (_isTableMissing(err)) return _memResendCount(email);
    throw err;
  }
}

async function _storeOtp(email, otpHash, resendCount) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);

  // Clear previous unverified records for this email
  try {
    await supabase
      .from("email_verifications")
      .delete()
      .eq("email", email)
      .eq("verified", false);
  } catch { /* non-fatal — proceed with insert */ }

  try {
    const { error } = await supabase.from("email_verifications").insert({
      email,
      otp_hash: otpHash,
      attempts: 0,
      resend_count: resendCount,
      verified: false,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    if (error) {
      if (_isTableMissing(error)) {
        _memCreate(email, otpHash, resendCount);
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
      _memCreate(email, otpHash, resendCount);
      console.warn("[OTP Service] Falling back to in-memory OTP store.");
      return;
    }
    throw err;
  }
}

async function _getActiveRecord(email) {
  try {
    const { data, error } = await supabase
      .from("email_verifications")
      .select("*")
      .eq("email", email)
      .eq("verified", false)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (_isTableMissing(error) || error.code === "PGRST116") return _memGetActive(email);
      throw error;
    }
    return data || _memGetActive(email);
  } catch (err) {
    if (_isTableMissing(err)) return _memGetActive(email);
    throw err;
  }
}

async function _incrementAttempts(recordId, currentAttempts, email) {
  if (String(recordId).startsWith("mem-")) {
    const r = _mem.get(_memKey(email));
    if (r) r.attempts = currentAttempts + 1;
    return;
  }
  try {
    await supabase
      .from("email_verifications")
      .update({ attempts: currentAttempts + 1 })
      .eq("id", recordId);
  } catch {
    const r = _mem.get(_memKey(email));
    if (r) r.attempts = currentAttempts + 1;
  }
}

async function _markVerified(recordId, email) {
  if (String(recordId).startsWith("mem-")) {
    const r = _mem.get(_memKey(email));
    if (r) { r.verified = true; r.verifiedAt = Date.now(); }
    return;
  }
  try {
    await supabase
      .from("email_verifications")
      .update({ verified: true, verified_at: new Date().toISOString() })
      .eq("id", recordId);
  } catch {
    const r = _mem.get(_memKey(email));
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
 * @returns {Promise<string>} plain-text OTP
 */
async function sendOtp(email) {
  const normalized = email.toLowerCase();

  const count = await _getResendCount(normalized);
  if (count >= MAX_RESENDS) {
    const err = new Error(
      "Too many verification requests. Please wait 10 minutes before trying again."
    );
    err.status = 429;
    throw err;
  }

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, 10);
  await _storeOtp(normalized, otpHash, count + 1);

  console.log(`[OTP Service] OTP created for <${normalized}> (send #${count + 1})`);
  return otp;
}

/**
 * Verifies the 6-digit OTP for the given email.
 * Enforces max 5 attempts and 10-minute expiry.
 * On success, returns a signed 15-minute verification JWT.
 *
 * @param {string} email
 * @param {string} otp
 * @returns {Promise<{ verified: true, verificationToken: string }>}
 */
async function verifyOtp(email, otp) {
  const normalized = email.toLowerCase();

  const record = await _getActiveRecord(normalized);
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

  await _incrementAttempts(record.id, attempts, normalized);

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

  await _markVerified(record.id, normalized);

  const verificationToken = jwt.sign(
    { purpose: "email_verification", email: normalized },
    JWT_SECRET,
    { expiresIn: VERIFICATION_TOKEN_TTL }
  );

  console.log(`[OTP Service] Email <${normalized}> verified successfully`);
  return { verified: true, verificationToken };
}

module.exports = { sendOtp, verifyOtp };
