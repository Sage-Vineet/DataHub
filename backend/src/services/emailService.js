const nodemailer = require("nodemailer");

function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || SMTP_PASS === "REPLACE_WITH_16_CHAR_APP_PASSWORD") {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || "587", 10),
    secure: SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    from: SMTP_FROM || SMTP_USER,
  });
}

async function sendReminderEmail({ toName, toEmail, requestTitle, dueDate, senderName, companyName }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("[emailService] SMTP not configured — skipping reminder email");
    return;
  }

  const formattedDue = dueDate ? new Date(dueDate).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : null;
  const greeting = toName ? `Hi ${toName},` : "Hi,";
  const sentBy = senderName || "Your broker";

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
      <p>Please log in to the DataHub portal to complete and submit any outstanding documents.</p>
      <p style="margin-top:24px;color:#6d6e71;font-size:13px">This is an automated reminder. Please do not reply to this email.</p>
    </div>
  `;

  const text = [
    greeting,
    "",
    `${sentBy} has sent you a reminder for: ${requestTitle || "Document Request"}`,
    formattedDue ? `Due: ${formattedDue}` : "",
    "",
    "Please log in to the DataHub portal to complete any outstanding documents.",
  ].filter((l) => l !== undefined).join("\n");

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: `Reminder: ${requestTitle || "Document Request"}`,
    text,
    html,
  });
}

module.exports = { sendReminderEmail };
