"use strict";

const nodemailer = require("nodemailer");

// In-process dedup guard — prevents double-send if the controller is somehow
// invoked twice for the same user within the same server lifetime.
const _sentWelcomeEmails = new Set();

function isEmailConfigured() {
  return !!(
    process.env.EMAIL_HOST &&
    process.env.EMAIL_USER &&
    process.env.EMAIL_PASS
  );
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || "587", 10),
    secure: process.env.EMAIL_SECURE === "true",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

function buildWelcomeEmailHtml(userName, email, password, companyDisplay, loginUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to  M&A Hub</title>
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
    <div class="header">
      <h1>Welcome to M&A Hub</h1>
    </div>
    <div class="body">
      <p class="greeting">Hello ${escapeHtml(userName)},</p>
      <p class="intro">Your M&A Hub account has been created successfully. Use the credentials below to sign in.</p>
      <div class="credentials">
        <table>
          <tr>
            <td>Company</td>
            <td>${escapeHtml(companyDisplay)}</td>
          </tr>
          <tr>
            <td>Login Email</td>
            <td>${escapeHtml(email)}</td>
          </tr>
          <tr>
            <td>Password</td>
            <td>${escapeHtml(password)}</td>
          </tr>
          <tr>
            <td>Login URL</td>
            <td><a href="${escapeHtml(loginUrl)}" style="color:#05164D">${escapeHtml(loginUrl)}</a></td>
          </tr>
        </table>
      </div>
      <div class="tip">
        <span class="tip-icon">&#128273;</span>
        After signing in, you can change your password anytime from <strong>Profile Settings</strong>.
      </div>
      <div class="cta">
        <a href="${escapeHtml(loginUrl)}">Sign In to  M&A Hub</a>
      </div>
      <p class="note">
        For security, please update your password immediately after your first login.<br />
        If you did not expect this email, please contact your  M&A Hub administrator.
      </p>
    </div>
    <div class="footer"> M&A Hub Team &mdash; This is an automated message, please do not reply.</div>
  </div>
</body>
</html>`;
}

function buildWelcomeEmailText(userName, email, password, companyDisplay, loginUrl) {
  return [
    `Hello ${userName},`,
    "",
    "Your  M&A Hub account has been created successfully.",
    "",
    `Company:           ${companyDisplay}`,
    `Login Email:       ${email}`,
    `Temporary Password: ${password}`,
    `Login URL:         ${loginUrl}`,
    "",
    "Please sign in and update your password after your first login.",
    "",
    "Regards,",
    " M&A Hub Team",
  ].join("\n");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function _attemptSend(transporter, mailOptions) {
  const info = await transporter.sendMail(mailOptions);
  return info;
}

async function _sendWithRetry(transporter, mailOptions, maxRetries) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const info = await _attemptSend(transporter, mailOptions);
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

/**
 * Sends a welcome/invitation email to a newly created user.
 *
 * @param {object} params
 * @param {string} params.userId        - User UUID (used for dedup)
 * @param {string} params.userName      - Full name of the new user
 * @param {string} params.email         - Email address of the new user
 * @param {string} params.password      - Plain-text password set by the admin
 * @param {string[]} params.companyNames - List of assigned company names
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string, error?: string }>}
 */
async function sendWelcomeEmail({ userId, userName, email, password, companyNames }) {
  const dedupeKey = `welcome:${userId}`;

  if (_sentWelcomeEmails.has(dedupeKey)) {
    console.log(
      `[Email Service] Skipping duplicate welcome email for user ${userId}`
    );
    return { sent: false, reason: "duplicate" };
  }

  if (!isEmailConfigured()) {
    console.warn(
      "[Email Service] SMTP not configured (EMAIL_HOST / EMAIL_USER / EMAIL_PASS missing). " +
      "Skipping welcome email."
    );
    return { sent: false, reason: "not_configured" };
  }

  const loginUrl =
    process.env.FRONTEND_URL || "http://localhost:5173";
  const companyDisplay =
    Array.isArray(companyNames) && companyNames.length
      ? companyNames.join(", ")
      : "N/A";

  const mailOptions = {
    from:
      process.env.EMAIL_FROM ||
      `"M&A Hub" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Welcome to  M&A Hub – Your Account Has Been Created",
    html: buildWelcomeEmailHtml(userName, email, password, companyDisplay, loginUrl),
    text: buildWelcomeEmailText(userName, email, password, companyDisplay, loginUrl),
  };

  try {
    const transporter = createTransporter();
    const { info, attempt } = await _sendWithRetry(transporter, mailOptions, 3);
    _sentWelcomeEmails.add(dedupeKey);
    console.log(
      `[Email Service] Welcome email sent to <${email}> ` +
      `(user ${userId}, attempt ${attempt}, messageId: ${info.messageId})`
    );
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(
      `[Email Service] All retries exhausted for <${email}> (user ${userId}): ${err.message}`
    );
    return { sent: false, reason: "delivery_failed", error: err.message };
  }
}

// ── OTP / Email Verification Email ───────────────────────────────────────────

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
    <div class="header">
      <h1>Email Verification</h1>
    </div>
    <div class="body">
      <p class="label">Your M&A Hub verification code is:</p>
      <div class="otp-box">
        <div class="otp">${otp}</div>
      </div>
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
 *
 * @param {string} email  - Recipient address
 * @param {string} otp    - Plain-text 6-digit OTP (never stored after this call)
 * @returns {Promise<{ sent: boolean, messageId?: string, reason?: string }>}
 */
async function sendOtpEmail(email, otp) {
  if (!isEmailConfigured()) {
    console.warn("[Email Service] SMTP not configured — cannot send OTP email.");
    return { sent: false, reason: "not_configured" };
  }

  const mailOptions = {
    from: process.env.EMAIL_FROM || `"M&A Hub" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "M&A Hub Email Verification Code",
    html: buildOtpEmailHtml(otp),
    text: buildOtpEmailText(otp),
  };

  try {
    const transporter = createTransporter();
    const { info, attempt } = await _sendWithRetry(transporter, mailOptions, 3);
    console.log(
      `[Email Service] OTP email sent to <${email}> (attempt ${attempt}, messageId: ${info.messageId})`
    );
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email Service] OTP email failed for <${email}>: ${err.message}`);
    return { sent: false, reason: "delivery_failed", error: err.message };
  }
}

module.exports = { sendWelcomeEmail, sendOtpEmail, isEmailConfigured };
