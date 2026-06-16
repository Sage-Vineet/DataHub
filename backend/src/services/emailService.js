"use strict";

/**
 * emailService.js — Production-hardened email delivery
 *
 * Transport priority (first that works wins):
 *   1. Resend API  — HTTPS port 443, works on Render/any host (set RESEND_API_KEY)
 *   2. SMTP port 587 — Gmail TLS  (blocked on Render free tier)
 *   3. SMTP port 465 — Gmail SSL  (also blocked on Render free tier)
 *
 * Render blocks outbound SMTP (ports 587/465). For production set RESEND_API_KEY.
 * Resend free tier: 3 000 emails/month · sign up at https://resend.com
 */

const nodemailer = require("nodemailer");
const axios      = require("axios");
const dns        = require("dns");
const { promisify } = require("util");

const dnsLookup = promisify(dns.lookup);

// In-process dedup guard — prevents double welcome-send per server lifetime.
const _sentWelcomeEmails = new Set();

// ── Configuration helpers ─────────────────────────────────────────────────────

function _smtpCfg() {
  return {
    host:   process.env.EMAIL_HOST   || process.env.SMTP_HOST   || "",
    port:   parseInt(process.env.EMAIL_PORT   || process.env.SMTP_PORT   || "587", 10),
    secure: (process.env.EMAIL_SECURE || process.env.SMTP_SECURE) === "true",
    user:   process.env.EMAIL_USER   || process.env.SMTP_USER   || "",
    pass:   process.env.EMAIL_PASS   || process.env.SMTP_PASS   || "",
  };
}

function isSmtpConfigured() {
  const { host, user, pass } = _smtpCfg();
  return !!(host && user && pass);
}

function isResendConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function _from() {
  return (
    process.env.EMAIL_FROM ||
    process.env.SMTP_FROM  ||
    `"M&A Hub" <${process.env.EMAIL_USER || process.env.SMTP_USER}>`
  );
}

// ── IPv4 DNS resolver ─────────────────────────────────────────────────────────

async function _resolveIPv4(hostname) {
  // If already an IP address, use as-is.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
  try {
    const { address, family } = await dnsLookup(hostname, { family: 4 });
    console.log(`[SMTP] DNS ${hostname} → ${address} (IPv${family})`);
    return address;
  } catch (err) {
    console.warn(`[SMTP] DNS IPv4 lookup failed for ${hostname}: ${err.message} — using hostname directly`);
    return hostname;
  }
}

// ── Transporter factory ───────────────────────────────────────────────────────

async function _buildTransporter(host, port, secure) {
  const { user, pass } = _smtpCfg();
  const resolvedHost = await _resolveIPv4(host);

  console.log(`[SMTP] Creating transporter → host=${resolvedHost} port=${port} secure=${secure}`);

  return nodemailer.createTransport({
    host:             resolvedHost,
    port,
    secure,
    auth:             { user, pass },
    family:           4,          // redundant safety net after DNS resolution
    connectionTimeout: 10000,
    greetingTimeout:   10000,
    socketTimeout:     15000,
    tls:              { rejectUnauthorized: false },
  });
}

// ── Resend API sender ─────────────────────────────────────────────────────────

async function _sendViaResend(to, subject, html, text) {
  console.log(`[Email Service] Trying Resend API for <${to}>`);
  const response = await axios.post(
    "https://api.resend.com/emails",
    { from: _from(), to: [to], subject, html, text },
    {
      headers: {
        Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
  return response.data; // { id: "..." }
}

// ── SMTP sender with per-port retry ──────────────────────────────────────────

async function _smtpSend(transporter, mailOptions, label, maxRetries = 3) {
  let lastErr;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      return { info, attempt: i };
    } catch (err) {
      lastErr = err;
      console.error(`[SMTP][${label}] Attempt ${i}/${maxRetries} failed: ${err.message}`);
      if (i < maxRetries) await new Promise(r => setTimeout(r, i * 1000));
    }
  }
  throw lastErr;
}

// ── Core delivery router ──────────────────────────────────────────────────────

async function _deliver(to, subject, html, text) {
  const mailOptions = { from: _from(), to, subject, html, text };

  // ── 1. Resend API (always works on Render — HTTPS port 443) ─────────────────
  if (isResendConfigured()) {
    try {
      const result = await _sendViaResend(to, subject, html, text);
      console.log(`[Email Service] ✓ Delivered via Resend API to <${to}> id=${result.id}`);
      return { sent: true, provider: "resend", messageId: result.id };
    } catch (err) {
      console.error(`[Email Service] Resend API failed for <${to}>: ${err.message}`);
      if (err.response) {
        console.error(`[Email Service] Resend HTTP ${err.response.status}:`, JSON.stringify(err.response.data));
      }
      // fall through to SMTP
    }
  }

  // ── 2. SMTP port 587 (TLS STARTTLS) ─────────────────────────────────────────
  if (isSmtpConfigured()) {
    const { host, user } = _smtpCfg();
    console.log(`[SMTP] Attempting port 587 (TLS) — host=${host} user=${user}`);

    try {
      const t587 = await _buildTransporter(host, 587, false);
      await t587.verify();
      console.log("[SMTP] verify() passed on port 587");
      const { info, attempt } = await _smtpSend(t587, mailOptions, "587", 3);
      console.log(`[Email Service] ✓ Delivered via SMTP 587 to <${to}> attempt=${attempt} id=${info.messageId}`);
      return { sent: true, provider: "smtp", port: 587, messageId: info.messageId };
    } catch (err587) {
      console.error(`[SMTP] Port 587 failed: ${err587.message}`);
      console.error(`[SMTP] Stack: ${err587.stack}`);
      if (err587.code === "ENETUNREACH" || err587.code === "ECONNREFUSED" || err587.code === "ETIMEDOUT") {
        console.error("[SMTP] Network diagnosis: Render likely blocks outbound SMTP port 587. Set RESEND_API_KEY.");
      }

      // ── 3. SMTP port 465 (SSL) fallback ───────────────────────────────────
      console.log(`[SMTP] Falling back to port 465 (SSL) — host=${host}`);
      try {
        const t465 = await _buildTransporter(host, 465, true);
        await t465.verify();
        console.log("[SMTP] verify() passed on port 465");
        const { info, attempt } = await _smtpSend(t465, mailOptions, "465", 2);
        console.log(`[Email Service] ✓ Delivered via SMTP 465 to <${to}> attempt=${attempt} id=${info.messageId}`);
        return { sent: true, provider: "smtp", port: 465, messageId: info.messageId };
      } catch (err465) {
        console.error(`[SMTP] Port 465 also failed: ${err465.message}`);
        if (err465.code === "ENETUNREACH" || err465.code === "ECONNREFUSED" || err465.code === "ETIMEDOUT") {
          console.error(
            "[SMTP] CONCLUSION: Render is blocking outbound SMTP on both port 587 and 465.\n" +
            "[SMTP] FIX: Add RESEND_API_KEY to Render environment variables.\n" +
            "[SMTP] Sign up free at https://resend.com — 3000 emails/month included."
          );
        }
        throw err465;
      }
    }
  }

  throw new Error(
    "No email transport available. " +
    "Set RESEND_API_KEY (recommended for Render) or EMAIL_HOST + EMAIL_USER + EMAIL_PASS."
  );
}

// ── SMTP / Resend health check (called at startup) ────────────────────────────

async function checkEmailHealth() {
  console.log("[EMAIL HEALTH CHECK] Starting...");
  console.log(`[EMAIL HEALTH CHECK] RESEND_API_KEY configured: ${isResendConfigured()}`);
  console.log(`[EMAIL HEALTH CHECK] SMTP configured: ${isSmtpConfigured()}`);

  if (isResendConfigured()) {
    // Verify Resend key by calling the /domains endpoint (read-only, no email sent)
    try {
      await axios.get("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        timeout: 8000,
      });
      console.log("[EMAIL HEALTH CHECK] SUCCESS — Resend API key is valid");
      return true;
    } catch (err) {
      const status = err.response?.status;
      if (status === 401) {
        console.error("[EMAIL HEALTH CHECK] FAILED — Resend API key is invalid (401 Unauthorized)");
      } else {
        console.error(`[EMAIL HEALTH CHECK] FAILED — Resend API unreachable: ${err.message}`);
      }
      return false;
    }
  }

  if (isSmtpConfigured()) {
    const { host, user } = _smtpCfg();
    console.log(`[EMAIL HEALTH CHECK] Testing SMTP — host=${host} user=${user} (password hidden)`);
    try {
      const transporter = await _buildTransporter(host, 587, false);
      await transporter.verify();
      console.log("[EMAIL HEALTH CHECK] SUCCESS — SMTP port 587 reachable and authenticated");
      return true;
    } catch (err) {
      console.error(`[EMAIL HEALTH CHECK] FAILED — SMTP port 587: ${err.message}`);
      try {
        const t465 = await _buildTransporter(host, 465, true);
        await t465.verify();
        console.log("[EMAIL HEALTH CHECK] SUCCESS — SMTP port 465 reachable and authenticated");
        return true;
      } catch (err2) {
        console.error(`[EMAIL HEALTH CHECK] FAILED — SMTP port 465: ${err2.message}`);
        console.error(
          "[EMAIL HEALTH CHECK] CONCLUSION: All SMTP ports blocked (likely Render restriction).\n" +
          "[EMAIL HEALTH CHECK] ACTION REQUIRED: Set RESEND_API_KEY in Render environment.\n" +
          "[EMAIL HEALTH CHECK] Free signup: https://resend.com"
        );
        return false;
      }
    }
  }

  console.error("[EMAIL HEALTH CHECK] FAILED — No email transport configured at all.");
  return false;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ── OTP email templates ───────────────────────────────────────────────────────

function _buildOtpHtml(otp) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Verification Code</title>
  <style>
    body{margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif}
    .wrap{max-width:480px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .hdr{background:#05164D;padding:28px 40px;text-align:center}
    .hdr h1{color:#fff;margin:0;font-size:20px;letter-spacing:.5px}
    .bdy{padding:36px 40px;text-align:center}
    .lbl{font-size:14px;color:#555;margin-bottom:24px;line-height:1.6}
    .box{display:inline-block;background:#f0f4ff;border:2px solid #c3d0f0;border-radius:10px;padding:20px 44px;margin-bottom:24px}
    .otp{font-size:40px;font-weight:800;letter-spacing:12px;color:#05164D;font-family:'Courier New',monospace}
    .exp{font-size:13px;color:#888;margin-bottom:24px}
    .wrn{font-size:12px;color:#aaa;border-top:1px solid #f0f0f0;padding-top:20px;line-height:1.6}
    .ftr{background:#f4f6f9;padding:16px 40px;text-align:center;font-size:12px;color:#aaa}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr"><h1>Email Verification</h1></div>
    <div class="bdy">
      <p class="lbl">Your M&amp;A Hub verification code is:</p>
      <div class="box"><div class="otp">${otp}</div></div>
      <p class="exp">This code expires in <strong>10 minutes</strong>.</p>
      <p class="wrn">If you did not request this, please ignore this email.<br/>Never share this code with anyone.</p>
    </div>
    <div class="ftr">M&amp;A Hub Team &mdash; Automated message, do not reply.</div>
  </div>
</body>
</html>`;
}

function _buildOtpText(otp) {
  return [
    "M&A Hub Email Verification Code",
    "",
    `Your verification code is: ${otp}`,
    "",
    "This code expires in 10 minutes.",
    "",
    "If you did not request this, please ignore this email.",
    "Never share this code with anyone.",
    "",
    "M&A Hub Team",
  ].join("\n");
}

// ── Welcome email templates ───────────────────────────────────────────────────

function _buildWelcomeHtml(userName, email, password, companyDisplay, loginUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Welcome to M&amp;A Hub</title>
  <style>
    body{margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif}
    .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .hdr{background:#05164D;padding:32px 40px;text-align:center}
    .hdr h1{color:#fff;margin:0;font-size:22px;letter-spacing:.5px}
    .bdy{padding:36px 40px}
    .creds{background:#f8f9fc;border:1px solid #e0e4ef;border-radius:6px;padding:20px 24px;margin-bottom:28px}
    .creds table{width:100%;border-collapse:collapse}
    .creds td{padding:6px 0;font-size:14px;vertical-align:top}
    .creds td:first-child{color:#6b7a99;width:160px;font-weight:600}
    .tip{background:#eef6ff;border:1px solid #c3daf9;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#1a4d8f;line-height:1.6}
    .cta{text-align:center;margin-bottom:28px}
    .cta a{display:inline-block;background:#8BC53D;color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:14px;font-weight:700}
    .note{font-size:13px;color:#888;line-height:1.6;border-top:1px solid #f0f0f0;padding-top:20px}
    .ftr{background:#f4f6f9;padding:20px 40px;text-align:center;font-size:12px;color:#aaa}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr"><h1>Welcome to M&amp;A Hub</h1></div>
    <div class="bdy">
      <p style="font-size:16px;color:#1a1a2e;margin-bottom:16px">Hello ${escapeHtml(userName)},</p>
      <p style="font-size:14px;color:#444;line-height:1.6;margin-bottom:28px">Your M&amp;A Hub account has been created. Use the credentials below to sign in.</p>
      <div class="creds">
        <table>
          <tr><td>Company</td><td>${escapeHtml(companyDisplay)}</td></tr>
          <tr><td>Login Email</td><td>${escapeHtml(email)}</td></tr>
          <tr><td>Password</td><td>${escapeHtml(password)}</td></tr>
          <tr><td>Login URL</td><td><a href="${escapeHtml(loginUrl)}" style="color:#05164D">${escapeHtml(loginUrl)}</a></td></tr>
        </table>
      </div>
      <div class="tip">&#128273; After signing in, you can change your password from <strong>Profile Settings</strong>.</div>
      <div class="cta"><a href="${escapeHtml(loginUrl)}">Sign In to M&amp;A Hub</a></div>
      <p class="note">For security, update your password after your first login.<br/>If you did not expect this email, contact your M&amp;A Hub administrator.</p>
    </div>
    <div class="ftr">M&amp;A Hub Team &mdash; Automated message, do not reply.</div>
  </div>
</body>
</html>`;
}

function _buildWelcomeText(userName, email, password, companyDisplay, loginUrl) {
  return [
    `Hello ${userName},`,
    "",
    "Your M&A Hub account has been created successfully.",
    "",
    `Company:            ${companyDisplay}`,
    `Login Email:        ${email}`,
    `Temporary Password: ${password}`,
    `Login URL:          ${loginUrl}`,
    "",
    "Please sign in and update your password after your first login.",
    "",
    "Regards, M&A Hub Team",
  ].join("\n");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sends a 6-digit OTP verification email.
 */
async function sendOtpEmail(email, otp) {
  console.log("EMAIL_HOST:", process.env.EMAIL_HOST);
  console.log("EMAIL_USER:", process.env.EMAIL_USER);
  console.log(`[Email Service] EMAIL_PASS exists: ${!!process.env.EMAIL_PASS}`);
  console.log(`[Email Service] RESEND_API_KEY configured: ${isResendConfigured()}`);

  try {
    const result = await _deliver(
      email,
      "M&A Hub Email Verification Code",
      _buildOtpHtml(otp),
      _buildOtpText(otp)
    );
    return result;
  } catch (err) {
    console.error(`[Email Service] OTP delivery completely failed for <${email}>: ${err.message}`);
    return { sent: false, reason: "delivery_failed", error: err.message };
  }
}

/**
 * Sends a welcome/invitation email to a newly created user.
 */
async function sendWelcomeEmail({ userId, userName, email, password, companyNames }) {
  const dedupeKey = `welcome:${userId}`;
  if (_sentWelcomeEmails.has(dedupeKey)) {
    console.log(`[Email Service] Skipping duplicate welcome email for user ${userId}`);
    return { sent: false, reason: "duplicate" };
  }

  const loginUrl       = process.env.FRONTEND_URL || "http://localhost:5173";
  const companyDisplay = Array.isArray(companyNames) && companyNames.length
    ? companyNames.join(", ")
    : "N/A";

  try {
    const result = await _deliver(
      email,
      "Welcome to M&A Hub – Your Account Has Been Created",
      _buildWelcomeHtml(userName, email, password, companyDisplay, loginUrl),
      _buildWelcomeText(userName, email, password, companyDisplay, loginUrl)
    );
    if (result.sent) _sentWelcomeEmails.add(dedupeKey);
    return result;
  } catch (err) {
    console.error(`[Email Service] Welcome email failed for <${email}>: ${err.message}`);
    return { sent: false, reason: "delivery_failed", error: err.message };
  }
}

/**
 * Sends a document-request reminder email.
 * Optional enhanced fields: requestType, description, priority, status, reminderAt, portalUrl.
 */
async function sendReminderEmail({
  toName, toEmail, requestTitle, dueDate, senderName, companyName,
  requestType, description, priority, status, reminderAt, portalUrl,
}) {
  const formattedDue = dueDate
    ? new Date(dueDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;
  const formattedReminderAt = reminderAt
    ? new Date(reminderAt).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  const sentBy   = senderName || "Your broker";
  const title    = escapeHtml(requestTitle || "Document Request");

  const detailRows = [
    companyName    ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600;width:140px">Company</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(companyName)}</td></tr>` : "",
    requestType    ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Type</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(requestType)}</td></tr>` : "",
    description    ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600;vertical-align:top">Description</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(description)}</td></tr>` : "",
    priority       ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Priority</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5;text-transform:capitalize">${escapeHtml(priority)}</td></tr>` : "",
    formattedDue   ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Due Date</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${formattedDue}</td></tr>` : "",
    status         ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Status</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5;text-transform:capitalize">${escapeHtml(status)}</td></tr>` : "",
    formattedReminderAt ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Reminder Sent</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${formattedReminderAt}</td></tr>` : "",
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#333">
      <p>${greeting}</p>
      <p>${escapeHtml(sentBy)} has sent you a reminder for the following document request:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600;width:140px">Request</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${title}</td></tr>
        ${detailRows}
      </table>
      <p>Please log in to the M&amp;A Hub portal to complete any outstanding documents.</p>
      ${portalUrl ? `<p style="margin:16px 0"><a href="${escapeHtml(portalUrl)}" style="background:#05164D;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Open Request Portal</a></p>` : ""}
      <p style="margin-top:24px;color:#6d6e71;font-size:13px">Automated reminder — do not reply.</p>
    </div>`;

  const textLines = [
    greeting, "",
    `${sentBy} has sent you a reminder for: ${requestTitle || "Document Request"}`,
    companyName        ? `Company:      ${companyName}` : "",
    requestType        ? `Type:         ${requestType}` : "",
    priority           ? `Priority:     ${priority}` : "",
    formattedDue       ? `Due:          ${formattedDue}` : "",
    status             ? `Status:       ${status}` : "",
    formattedReminderAt ? `Reminder Sent: ${formattedReminderAt}` : "",
    description        ? `\nDescription:\n${description}` : "",
    "",
    "Please log in to the M&A Hub portal to complete any outstanding documents.",
    portalUrl ? `Portal: ${portalUrl}` : "",
  ].filter(Boolean).join("\n");

  try {
    await _deliver(toEmail, `Reminder: Action Required for Request - ${requestTitle || "Document Request"}`, html, textLines);
  } catch (err) {
    console.error(`[Email Service] Reminder email failed for <${toEmail}>: ${err.message}`);
  }
}

/**
 * Sends a new-request assignment notification email to a client team member.
 */
async function sendRequestNotificationEmail({ toName, toEmail, requestTitle, dueDate, senderName, companyName }) {
  const formattedDue = dueDate
    ? new Date(dueDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  const sentBy   = senderName || "Your broker";

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#333">
      <p>${greeting}</p>
      <p>${escapeHtml(sentBy)} has created a new document request for you:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600;width:140px">Request</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(requestTitle || "Document Request")}</td></tr>
        ${companyName ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Company</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(companyName)}</td></tr>` : ""}
        ${formattedDue ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Due Date</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${formattedDue}</td></tr>` : ""}
      </table>
      <p>Please log in to the M&amp;A Hub portal to view and complete this request.</p>
      <p style="margin-top:24px;color:#6d6e71;font-size:13px">Automated notification — do not reply.</p>
    </div>`;

  const text = [
    greeting, "",
    `${sentBy} has created a new document request: ${requestTitle || "Document Request"}`,
    formattedDue ? `Due: ${formattedDue}` : "",
    "", "Please log in to the M&A Hub portal to view and complete this request.",
  ].filter(Boolean).join("\n");

  try {
    await _deliver(toEmail, `New Request: ${requestTitle || "Document Request"}`, html, text);
  } catch (err) {
    console.error(`[Email Service] Request notification failed for <${toEmail}>: ${err.message}`);
  }
}

/**
 * Sends a company-created notification email to the primary contact.
 * Does NOT include credentials — the contact's login details are provided
 * separately by the welcome email sent when the user account is created.
 */
async function sendCompanyCreatedEmail({ toName, toEmail, companyName, projectName, brokerName, portalUrl }) {
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  const sentBy   = brokerName || "Your M&A Hub broker";
  const portal   = portalUrl || (process.env.FRONTEND_URL || process.env.APP_BASE_URL || "");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Company Created – M&amp;A Hub</title>
  <style>
    body{margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif}
    .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .hdr{background:#05164D;padding:32px 40px;text-align:center}
    .hdr h1{color:#fff;margin:0;font-size:22px;letter-spacing:.5px}
    .bdy{padding:36px 40px}
    .detail{background:#f8f9fc;border:1px solid #e0e4ef;border-radius:6px;padding:20px 24px;margin-bottom:28px}
    .detail table{width:100%;border-collapse:collapse}
    .detail td{padding:6px 0;font-size:14px;vertical-align:top}
    .detail td:first-child{color:#6b7a99;width:140px;font-weight:600}
    .steps{background:#eef6ff;border:1px solid #c3daf9;border-radius:6px;padding:14px 20px;margin-bottom:24px;font-size:13px;color:#1a4d8f;line-height:1.8}
    .cta{text-align:center;margin-bottom:28px}
    .cta a{display:inline-block;background:#8BC53D;color:#fff;text-decoration:none;padding:12px 32px;border-radius:6px;font-size:14px;font-weight:700}
    .note{font-size:13px;color:#888;line-height:1.6;border-top:1px solid #f0f0f0;padding-top:20px}
    .ftr{background:#f4f6f9;padding:20px 40px;text-align:center;font-size:12px;color:#aaa}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hdr"><h1>Company Created – M&amp;A Hub</h1></div>
    <div class="bdy">
      <p style="font-size:16px;color:#1a1a2e;margin-bottom:16px">${greeting}</p>
      <p style="font-size:14px;color:#444;line-height:1.6;margin-bottom:24px">
        Your company has been successfully created in M&amp;A Hub by ${escapeHtml(sentBy)}.
      </p>
      <div class="detail">
        <table>
          ${companyName ? `<tr><td>Company</td><td>${escapeHtml(companyName)}</td></tr>` : ""}
          ${projectName ? `<tr><td>Project Name</td><td>${escapeHtml(projectName)}</td></tr>` : ""}
          ${brokerName  ? `<tr><td>Created By</td><td>${escapeHtml(brokerName)}</td></tr>` : ""}
        </table>
      </div>
      <div class="steps">
        <strong>Next Steps:</strong><br/>
        &#10003; Log in using your registered email address<br/>
        &#10003; Access requests, documents, and reports<br/>
        &#10003; Collaborate with your broker team<br/>
        &#10003; Track reminders and deal progress
      </div>
      ${portal ? `<div class="cta"><a href="${escapeHtml(portal)}">Access M&amp;A Hub Portal</a></div>` : ""}
      <p class="note">
        If you have not yet set up your login credentials, please contact your broker.<br/>
        For any questions, reply to your broker or contact the M&amp;A Hub support team.
      </p>
    </div>
    <div class="ftr">M&amp;A Hub Team &mdash; Automated message, do not reply.</div>
  </div>
</body>
</html>`;

  const text = [
    greeting, "",
    `Your company has been successfully created in M&A Hub by ${sentBy}.`, "",
    companyName ? `Company:      ${companyName}` : "",
    projectName ? `Project Name: ${projectName}` : "",
    brokerName  ? `Created By:   ${brokerName}`  : "",
    "",
    "Next Steps:",
    "- Log in using your registered email address",
    "- Access requests, documents, and reports",
    "- Collaborate with your broker team",
    "- Track reminders and deal progress",
    portal ? `\nPortal: ${portal}` : "",
    "",
    "If you have not yet set up your login credentials, please contact your broker.",
  ].filter(Boolean).join("\n");

  try {
    const result = await _deliver(toEmail, "Welcome to M&A Hub – Company Created Successfully", html, text);
    console.log(`[Audit] [Email Service] Company created notification delivered to <${toEmail}> provider=${result?.provider || "unknown"}`);
    return result;
  } catch (err) {
    console.error(`[Audit] [Email Service] Company created notification failed for <${toEmail}>: ${err.message}`);
    return { sent: false, reason: "delivery_failed", error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  sendOtpEmail,
  sendWelcomeEmail,
  sendReminderEmail,
  sendRequestNotificationEmail,
  sendCompanyCreatedEmail,
  checkEmailHealth,
  isSmtpConfigured,
  isResendConfigured,
};
