"use strict";

/**
 * emailService.js — Microsoft Graph API email delivery
 *
 * Uses OAuth 2.0 client_credentials flow to obtain a Bearer token from
 * Azure AD and sends email via POST /users/{sender}/sendMail on Graph.
 *
 * Required environment variables:
 *   GRAPH_TENANT_ID      — Azure AD Directory (tenant) ID
 *   GRAPH_CLIENT_ID      — Azure AD Application (client) ID
 *   GRAPH_CLIENT_SECRET  — Azure AD client secret value
 *   GRAPH_SENDER_EMAIL   — Licensed M365 mailbox to send from
 *   EMAIL_FROM_NAME      — Display name (default: "M&A Hub")
 *   FRONTEND_URL         — Used in welcome email login link
 */

const https = require("https");

// In-process dedup guard — prevents double welcome-send per server lifetime.
const _sentWelcomeEmails = new Set();

// ── Configuration helpers ─────────────────────────────────────────────────────

function isGraphConfigured() {
  return !!(
    process.env.GRAPH_TENANT_ID &&
    process.env.GRAPH_CLIENT_ID &&
    process.env.GRAPH_CLIENT_SECRET &&
    process.env.GRAPH_SENDER_EMAIL
  );
}

function _senderEmail() {
  return process.env.GRAPH_SENDER_EMAIL || "";
}

function _fromName() {
  return process.env.EMAIL_FROM_NAME || "M&A Hub";
}

// ── OAuth 2.0 token cache ─────────────────────────────────────────────────────
// Graph tokens are valid 60 minutes — reuse until 1 minute before expiry.

let _cachedToken = null;
let _tokenExpiresAt = 0;

async function _getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt - 60_000) {
    return _cachedToken;
  }

  const tenantId     = process.env.GRAPH_TENANT_ID;
  const clientId     = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Microsoft Graph not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET."
    );
  }

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     clientId,
    client_secret: clientSecret,
    scope:         "https://graph.microsoft.com/.default",
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "login.microsoftonline.com",
        path:     `/${tenantId}/oauth2/v2.0/token`,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) {
              _cachedToken    = json.access_token;
              _tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
              console.log("[Graph Auth] Access token obtained, expires in", json.expires_in, "s");
              resolve(_cachedToken);
            } else {
              reject(new Error(`Graph token error: ${json.error_description || json.error || data}`));
            }
          } catch (e) {
            reject(new Error(`Graph token parse error: ${e.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Core Graph send ───────────────────────────────────────────────────────────

async function _deliver(to, subject, html, text) {
  if (!isGraphConfigured()) {
    throw new Error(
      "Microsoft Graph email not configured. " +
      "Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER_EMAIL in .env"
    );
  }

  const token  = await _getAccessToken();
  const sender = _senderEmail();

  const payload = JSON.stringify({
    message: {
      subject,
      body: {
        contentType: "HTML",
        content:     html || text || "",
      },
      toRecipients: [
        { emailAddress: { address: to } },
      ],
      from: {
        emailAddress: { address: sender, name: _fromName() },
      },
    },
    saveToSentItems: false,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "graph.microsoft.com",
        path:     `/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
        method:   "POST",
        headers:  {
          Authorization:   `Bearer ${token}`,
          "Content-Type":  "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Graph returns 202 Accepted with no body on success
          if (res.statusCode === 202) {
            console.log(`[Email Service] Delivered via Graph API to <${to}> (202 Accepted)`);
            resolve({ sent: true, provider: "graph" });
          } else {
            // Invalidate cached token on auth errors so next call re-fetches
            if (res.statusCode === 401) {
              _cachedToken    = null;
              _tokenExpiresAt = 0;
            }
            reject(
              new Error(
                `Graph sendMail failed — HTTP ${res.statusCode}: ${data.slice(0, 400)}`
              )
            );
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Graph health check (called at server startup) ─────────────────────────────

async function checkEmailHealth() {
  console.log("[EMAIL HEALTH CHECK] Starting...");
  console.log(`[EMAIL HEALTH CHECK] Graph configured: ${isGraphConfigured()}`);

  if (!isGraphConfigured()) {
    console.error(
      "[EMAIL HEALTH CHECK] FAILED — Missing one or more Graph env vars:\n" +
      "  GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER_EMAIL"
    );
    return false;
  }

  try {
    const token = await _getAccessToken();
    if (!token) throw new Error("Empty token returned");
    console.log("[EMAIL HEALTH CHECK] SUCCESS — Graph access token obtained");

    // Verify the sender mailbox is accessible
    await new Promise((resolve, reject) => {
      const sender = _senderEmail();
      const req = https.request(
        {
          hostname: "graph.microsoft.com",
          path:     `/v1.0/users/${encodeURIComponent(sender)}/mailboxSettings`,
          method:   "GET",
          headers:  { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode === 200) {
              console.log(`[EMAIL HEALTH CHECK] SUCCESS — Sender mailbox <${sender}> accessible`);
              resolve();
            } else {
              reject(new Error(`Mailbox check HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

    return true;
  } catch (err) {
    console.error(`[EMAIL HEALTH CHECK] FAILED — ${err.message}`);
    if (err.message.includes("Forbidden") || err.message.includes("403")) {
      console.error(
        "[EMAIL HEALTH CHECK] Likely cause: Mail.Send permission not granted or admin consent missing.\n" +
        "  Fix: Azure Portal → App registrations → API permissions → Mail.Send → Grant admin consent"
      );
    }
    return false;
  }
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

// ── Password reset OTP email templates ────────────────────────────────────────

function _buildResetOtpHtml(otp) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Password Reset Code</title>
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
    <div class="hdr"><h1>Password Reset</h1></div>
    <div class="bdy">
      <p class="lbl">Your M&amp;A Hub password reset code is:</p>
      <div class="box"><div class="otp">${otp}</div></div>
      <p class="exp">This code expires in <strong>10 minutes</strong>.</p>
      <p class="wrn">If you did not request a password reset, please ignore this email — your password will not be changed.<br/>Never share this code with anyone.</p>
    </div>
    <div class="ftr">M&amp;A Hub Team &mdash; Automated message, do not reply.</div>
  </div>
</body>
</html>`;
}

function _buildResetOtpText(otp) {
  return [
    "M&A Hub Password Reset Code",
    "",
    `Your password reset code is: ${otp}`,
    "",
    "This code expires in 10 minutes.",
    "",
    "If you did not request a password reset, please ignore this email — your password will not be changed.",
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
  console.log(`[Email Service] Sending OTP to <${email}> via Graph API`);
  console.log(`[Email Service] Graph configured: ${isGraphConfigured()}`);

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
 * Sends a 6-digit OTP password reset email.
 */
async function sendPasswordResetOtpEmail(email, otp) {
  console.log(`[Email Service] Sending password reset OTP to <${email}> via Graph API`);
  console.log(`[Email Service] Graph configured: ${isGraphConfigured()}`);

  try {
    const result = await _deliver(
      email,
      "M&A Hub Password Reset Code",
      _buildResetOtpHtml(otp),
      _buildResetOtpText(otp)
    );
    return result;
  } catch (err) {
    console.error(`[Email Service] Password reset OTP delivery completely failed for <${email}>: ${err.message}`);
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

  const baseUrl  = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
  const loginUrl = `${baseUrl}/#/login`;
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
  frequencyLabel, nextReminderAt, noticeType = "reminder",
}) {
  const formattedDue = dueDate
    ? new Date(dueDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;
  const formattedReminderAt = reminderAt
    ? new Date(reminderAt).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const formattedNextReminderAt = nextReminderAt
    ? new Date(nextReminderAt).toLocaleString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  const sentBy   = senderName || "Your broker";
  const title    = escapeHtml(requestTitle || "Document Request");
  const isOverdue = noticeType === "overdue";
  const actionCopy = isOverdue
    ? "This request is now overdue. Please log in to the M&A Hub portal and complete it as soon as possible."
    : "Please log in to the M&A Hub portal to complete any outstanding documents.";

  const detailRows = [
    companyName    ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600;width:140px">Company</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(companyName)}</td></tr>` : "",
    requestType    ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Type</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(requestType)}</td></tr>` : "",
    description    ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600;vertical-align:top">Description</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(description)}</td></tr>` : "",
    priority       ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Priority</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5;text-transform:capitalize">${escapeHtml(priority)}</td></tr>` : "",
    formattedDue   ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Due Date</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${formattedDue}</td></tr>` : "",
    status         ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Status</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5;text-transform:capitalize">${escapeHtml(status)}</td></tr>` : "",
    frequencyLabel ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Cadence</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${escapeHtml(frequencyLabel)}</td></tr>` : "",
    formattedReminderAt ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Reminder Sent</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${formattedReminderAt}</td></tr>` : "",
    formattedNextReminderAt ? `<tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600">Next Reminder</td><td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${formattedNextReminderAt}</td></tr>` : "",
  ].filter(Boolean).join("\n");

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#333">
      <p>${greeting}</p>
      <p>${escapeHtml(sentBy)} has ${isOverdue ? "sent an overdue notice" : "sent you a reminder"} for the following document request:</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:8px 12px;background:#f5f7fa;font-weight:600;width:140px">Request</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e8edf5">${title}</td></tr>
        ${detailRows}
      </table>
      <p>${escapeHtml(actionCopy)}</p>
      ${portalUrl ? `<p style="margin:16px 0"><a href="${escapeHtml(portalUrl)}" style="background:#05164D;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Open Request Portal</a></p>` : ""}
      <p style="margin-top:24px;color:#6d6e71;font-size:13px">Automated ${isOverdue ? "overdue notice" : "reminder"} — do not reply.</p>
    </div>`;

  const textLines = [
    greeting, "",
    `${sentBy} has sent ${isOverdue ? "an overdue notice" : "a reminder"} for: ${requestTitle || "Document Request"}`,
    companyName         ? `Company:      ${companyName}` : "",
    requestType         ? `Type:         ${requestType}` : "",
    priority            ? `Priority:     ${priority}` : "",
    formattedDue        ? `Due:          ${formattedDue}` : "",
    status              ? `Status:       ${status}` : "",
    frequencyLabel      ? `Cadence:      ${frequencyLabel}` : "",
    formattedReminderAt ? `Reminder Sent: ${formattedReminderAt}` : "",
    formattedNextReminderAt ? `Next Reminder: ${formattedNextReminderAt}` : "",
    description         ? `\nDescription:\n${description}` : "",
    "",
    actionCopy,
    portalUrl ? `Portal: ${portalUrl}` : "",
  ].filter(Boolean).join("\n");

  try {
    return await _deliver(
      toEmail,
      `${isOverdue ? "Overdue Request" : "Reminder"}: ${requestTitle || "Document Request"}`,
      html,
      textLines
    );
  } catch (err) {
    console.error(`[Email Service] Reminder email failed for <${toEmail}>: ${err.message}`);
    return { sent: false, reason: "delivery_failed", error: err.message };
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
  sendPasswordResetOtpEmail,
  sendWelcomeEmail,
  sendReminderEmail,
  sendRequestNotificationEmail,
  sendCompanyCreatedEmail,
  checkEmailHealth,
  isGraphConfigured,
};
