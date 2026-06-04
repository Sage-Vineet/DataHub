"use strict";

const nodemailer = require("nodemailer");

// In-process dedup guard — prevents double-send within the same server lifetime.
const _sentWelcomeEmails = new Set();

// ── Configuration check ───────────────────────────────────────────────────────
// Supports both EMAIL_* (primary) and SMTP_* (legacy) env var sets.

function isEmailConfigured() {
  return !!(
    (process.env.EMAIL_HOST || process.env.SMTP_HOST) &&
    (process.env.EMAIL_USER || process.env.SMTP_USER) &&
    (process.env.EMAIL_PASS || process.env.SMTP_PASS)
  );
}

function createTransporter() {
  // Prefer EMAIL_* vars; fall back to SMTP_* for backward compatibility.
  const host   = process.env.EMAIL_HOST   || process.env.SMTP_HOST;
  const port   = parseInt(process.env.EMAIL_PORT   || process.env.SMTP_PORT   || "587", 10);
  const secure = (process.env.EMAIL_SECURE || process.env.SMTP_SECURE) === "true";
  const user   = process.env.EMAIL_USER   || process.env.SMTP_USER;
  const pass   = process.env.EMAIL_PASS   || process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

function _from() {
  return (
    process.env.EMAIL_FROM  ||
    process.env.SMTP_FROM   ||
    `"M&A Hub" <${process.env.EMAIL_USER || process.env.SMTP_USER}>`
  );
}

// ── Internal retry helper ─────────────────────────────────────────────────────

async function _sendWithRetry(transporter, mailOptions, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      return { info, attempt };
    } catch (err) {
      lastError = err;
      console.error(
        `[Email Service] Attempt ${attempt}/${maxRetries} failed for <${mailOptions.to}>: ${err.message}`
      );
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Welcome email (sent when broker adds a new user) ─────────────────────────

function buildWelcomeEmailHtml(userName, email, password, companyDisplay, loginUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to M&A Hub</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f6f9; font-family: Arial, Helvetica, sans-serif; }
    .wrapper { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .header { background: #05164D; padding: 32px 40px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 22px; letter-spacing: .5px; }
    .body { padding: 36px 40px; }
    .greeting { font-size: 16px; color: #1a1a2e; margin-bottom: 16px; }
    .intro { font-size: 14px; color: #444; line-height: 1.6; margin-bottom: 28px; }
    .credentials { background: #f8f9fc; border: 1px solid #e0e4ef; border-radius: 6px; padding: 20px 24px; margin-bottom: 28px; }
    .credentials table { width: 100%; border-collapse: collapse; }
    .credentials td { padding: 6px 0; font-size: 14px; vertical-align: top; }
    .credentials td:first-child { color: #6b7a99; width: 160px; font-weight: 600; }
    .credentials td:last-child { color: #1a1a2e; word-break: break-all; }
    .tip { background: #eef6ff; border: 1px solid #c3daf9; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; color: #1a4d8f; line-height: 1.6; }
    .tip-icon { margin-right: 6px; }
    .cta { text-align: center; margin-bottom: 28px; }
    .cta a { display: inline-block; background: #8BC53D; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 6px; font-size: 14px; font-weight: 700; }
    .note { font-size: 13px; color: #888; line-height: 1.6; border-top: 1px solid #f0f0f0; padding-top: 20px; }
    .footer { background: #f4f6f9; padding: 20px 40px; text-align: center; font-size: 12px; color: #aaa; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header"><h1>Welcome to M&A Hub</h1></div>
    <div class="body">
      <p class="greeting">Hello ${escapeHtml(userName)},</p>
      <p class="intro">Your M&A Hub account has been created successfully. Use the credentials below to sign in.</p>
      <div class="credentials">
        <table>
          <tr><td>Company</td><td>${escapeHtml(companyDisplay)}</td></tr>
          <tr><td>Login Email</td><td>${escapeHtml(email)}</td></tr>
          <tr><td>Password</td><td>${escapeHtml(password)}</td></tr>
          <tr><td>Login URL</td><td><a href="${escapeHtml(loginUrl)}" style="color:#05164D">${escapeHtml(loginUrl)}</a></td></tr>
        </table>
      </div>
      <div class="tip">
        <span class="tip-icon">&#128273;</span>
        After signing in, you can change your password anytime from <strong>Profile Settings</strong>.
      </div>
      <div class="cta"><a href="${escapeHtml(loginUrl)}">Sign In to M&A Hub</a></div>
      <p class="note">
        For security, please update your password immediately after your first login.<br />
        If you did not expect this email, please contact your M&A Hub administrator.
      </p>
    </div>
    <div class="footer">M&A Hub Team &mdash; This is an automated message, please do not reply.</div>
  </div>
</body>
</html>`;
}

function buildWelcomeEmailText(userName, email, password, companyDisplay, loginUrl) {
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
    "Regards,",
    "M&A Hub Team",
  ].join("\n");
}

/**
 * Sends a welcome/invitation email to a newly created user.
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string, error?: string }>}
 */
async function sendWelcomeEmail({ userId, userName, email, password, companyNames }) {
  const dedupeKey = `welcome:${userId}`;
  if (_sentWelcomeEmails.has(dedupeKey)) {
    console.log(`[Email Service] Skipping duplicate welcome email for user ${userId}`);
    return { sent: false, reason: "duplicate" };
  }

  if (!isEmailConfigured()) {
    console.warn("[Email Service] SMTP not configured — skipping welcome email.");
    return { sent: false, reason: "not_configured" };
  }

  const loginUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const companyDisplay =
    Array.isArray(companyNames) && companyNames.length ? companyNames.join(", ") : "N/A";

  const mailOptions = {
    from: _from(),
    to: email,
    subject: "Welcome to M&A Hub – Your Account Has Been Created",
    html: buildWelcomeEmailHtml(userName, email, password, companyDisplay, loginUrl),
    text: buildWelcomeEmailText(userName, email, password, companyDisplay, loginUrl),
  };

  try {
    const transporter = createTransporter();
    const { info, attempt } = await _sendWithRetry(transporter, mailOptions, 3);
    _sentWelcomeEmails.add(dedupeKey);
    console.log(
      `[Email Service] Welcome email sent to <${email}> (user ${userId}, attempt ${attempt}, messageId: ${info.messageId})`
    );
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email Service] All retries exhausted for <${email}> (user ${userId}): ${err.message}`);
    return { sent: false, reason: "delivery_failed", error: err.message };
  }
}

// ── OTP verification email ────────────────────────────────────────────────────

function buildOtpEmailHtml(otp) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verification Code</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f6f9; font-family: Arial, Helvetica, sans-serif; }
    .wrapper { max-width: 480px; margin: 40px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .header { background: #05164D; padding: 28px 40px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 20px; letter-spacing: .5px; }
    .body { padding: 36px 40px; text-align: center; }
    .label { font-size: 14px; color: #555; margin-bottom: 24px; line-height: 1.6; }
    .otp-box { display: inline-block; background: #f0f4ff; border: 2px solid #c3d0f0; border-radius: 10px; padding: 20px 44px; margin-bottom: 24px; }
    .otp { font-size: 40px; font-weight: 800; letter-spacing: 12px; color: #05164D; font-family: 'Courier New', monospace; }
    .expiry { font-size: 13px; color: #888; margin-bottom: 24px; }
    .warning { font-size: 12px; color: #aaa; border-top: 1px solid #f0f0f0; padding-top: 20px; line-height: 1.6; }
    .footer { background: #f4f6f9; padding: 16px 40px; text-align: center; font-size: 12px; color: #aaa; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header"><h1>Email Verification</h1></div>
    <div class="body">
      <p class="label">Your M&A Hub verification code is:</p>
      <div class="otp-box"><div class="otp">${otp}</div></div>
      <p class="expiry">This code expires in <strong>10 minutes</strong>.</p>
      <p class="warning">
        If you did not request this, please ignore this email.<br />
        Never share this code with anyone.
      </p>
    </div>
    <div class="footer">M&A Hub Team &mdash; Automated message, do not reply.</div>
  </div>
</body>
</html>`;
}

function buildOtpEmailText(otp) {
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

/**
 * Sends a 6-digit OTP verification email.
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string }>}
 */
async function sendOtpEmail(email, otp) {
  console.log("EMAIL_HOST:", process.env.EMAIL_HOST);
  console.log("EMAIL_USER:", process.env.EMAIL_USER);
  console.log("EMAIL_PASS exists:", !!process.env.EMAIL_PASS);

  if (!isEmailConfigured()) {
    console.warn("[Email Service] SMTP not configured — cannot send OTP email.");
    return { sent: false, reason: "not_configured" };
  }

  const mailOptions = {
    from: _from(),
    to: email,
    subject: "M&A Hub Email Verification Code",
    html: buildOtpEmailHtml(otp),
    text: buildOtpEmailText(otp),
  };

  try {
    const transporter = createTransporter();
    const { info, attempt } = await _sendWithRetry(transporter, mailOptions, 3);
    console.log(`[Email Service] OTP email sent to <${email}> (attempt ${attempt}, messageId: ${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email Service] OTP email failed for <${email}>: ${err.message}`);
    return { sent: false, reason: "delivery_failed", error: err.message };
  }
}

// ── Reminder email (document request reminders) ───────────────────────────────

/**
 * Sends a document-request reminder email to a client/user.
 */
async function sendReminderEmail({ toName, toEmail, requestTitle, dueDate, senderName, companyName }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("[Email Service] SMTP not configured — skipping reminder email.");
    return;
  }

  const formattedDue = dueDate
    ? new Date(dueDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  const sentBy   = senderName || "Your broker";

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#333">
      <p>${greeting}</p>
      <p>${sentBy} has sent you a reminder regarding the following document request:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr>
          <td style="padding:8px 12px;background:#f5f7fa;font-weight:600;width:140px">Request</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${requestTitle || "Document Request"}</td>
        </tr>
        ${companyName ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Company</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${companyName}</td></tr>` : ""}
        ${formattedDue ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Due Date</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${formattedDue}</td></tr>` : ""}
      </table>
      <p>Please log in to the M&A Hub portal to complete and submit any outstanding documents.</p>
      <p style="margin-top:24px;color:#6d6e71;font-size:13px">This is an automated reminder. Please do not reply to this email.</p>
    </div>
  `;

  const text = [
    greeting,
    "",
    `${sentBy} has sent you a reminder for: ${requestTitle || "Document Request"}`,
    formattedDue ? `Due: ${formattedDue}` : "",
    "",
    "Please log in to the M&A Hub portal to complete any outstanding documents.",
  ].filter((l) => l !== undefined).join("\n");

  await transporter.sendMail({
    from: _from(),
    to: toEmail,
    subject: `Reminder: ${requestTitle || "Document Request"}`,
    text,
    html,
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  sendWelcomeEmail,
  sendOtpEmail,
  sendReminderEmail,
  isEmailConfigured,
};
