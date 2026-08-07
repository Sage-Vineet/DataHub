#!/usr/bin/env node
"use strict";

/**
 * Diagnoses Microsoft Graph email configuration.
 *
 *   npm run verify:graph                              inspect configuration
 *   npm run verify:graph -- --send you@example.com    prove delivery works
 *
 * Separates the two things a 403 conflates:
 *   • AUTHENTICATION — can we obtain a token? (client id / secret / tenant)
 *   • AUTHORIZATION  — can that token actually send?
 *
 * A client_credentials token is issued whenever the secret is valid, regardless
 * of what has been consented, so "token obtained successfully" followed by
 * "403 Access is denied" always means permissions, never credentials.
 *
 * IMPORTANT: an empty `roles` claim does NOT prove sending is broken. App-only
 * send can be granted by Exchange Online RBAC for Applications or by a
 * directory role, neither of which appears in the token. This tenant is exactly
 * that case — no `roles` claim, yet sendMail returns 202. Only `--send` is
 * conclusive.
 */

require("dotenv").config();

const https = require("https");
const querystring = require("querystring");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const bad = (m) => console.log(`${RED}✗${RESET} ${m}`);
const warn = (m) => console.log(`${YELLOW}!${RESET} ${m}`);

const REQUIRED_ROLE = "Mail.Send";

function post(hostname, path, form) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(form);
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function decodeClaims(token) {
  const segment = String(token).split(".")[1];
  if (!segment) return null;
  return JSON.parse(
    Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  );
}

/** Masks an address so the output can be pasted into a ticket. */
function maskEmail(value) {
  const text = String(value || "");
  const at = text.indexOf("@");
  return at > 0 ? `${text[0]}***${text.slice(at)}` : "(unset)";
}

(async () => {
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;
  const sender = process.env.GRAPH_SENDER_EMAIL;

  console.log("");
  const missing = [
    ["GRAPH_TENANT_ID", tenantId],
    ["GRAPH_CLIENT_ID", clientId],
    ["GRAPH_CLIENT_SECRET", clientSecret],
    ["GRAPH_SENDER_EMAIL", sender],
  ].filter(([, v]) => !v);

  if (missing.length > 0) {
    bad(`Not configured — missing ${missing.map(([k]) => k).join(", ")}`);
    process.exit(1);
  }
  ok(`Configuration present · sender ${maskEmail(sender)}`);

  // ── Authentication ────────────────────────────────────────────────────────
  const response = await post(
    "login.microsoftonline.com",
    `/${tenantId}/oauth2/v2.0/token`,
    {
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }
  );

  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    bad(`Token endpoint returned unparseable response (HTTP ${response.status})`);
    process.exit(1);
  }

  if (!payload.access_token) {
    bad(`AUTHENTICATION failed — ${payload.error}`);
    console.log(`    ${String(payload.error_description || "").split("\n")[0]}`);
    if (payload.error === "invalid_client") {
      console.log(
        "\n    The client secret is wrong or EXPIRED. Azure secrets expire (often\n" +
          "    6–24 months). Entra ID → App registrations → Certificates & secrets."
      );
    }
    process.exit(1);
  }
  ok(`AUTHENTICATION succeeded — token valid ${payload.expires_in}s`);

  // ── Authorization ─────────────────────────────────────────────────────────
  const payloadToken = payload.access_token;
  const claims = decodeClaims(payloadToken) || {};
  const roles = Array.isArray(claims.roles) ? claims.roles : [];

  console.log(`\n  App id  : ${claims.appid}`);
  console.log(`  Tenant  : ${claims.tid}`);
  console.log(`  Audience: ${claims.aud}`);
  console.log(`  Roles   : ${roles.length ? roles.join(", ") : "(none)"}\n`);

  if (roles.includes(REQUIRED_ROLE)) {
    ok(`AUTHORIZATION — '${REQUIRED_ROLE}' present in the token's roles claim`);
  } else {
    // Not an error. Send capability can be granted by Exchange Online RBAC for
    // Applications or by a directory role, neither of which puts anything in
    // the `roles` claim. The only way to know is to send.
    warn("Mail.Send is not in the token's roles claim.");
    console.log(
      "\n  That does NOT necessarily mean sending is broken. App-only send can be\n" +
        "  granted three ways, and only the first appears in the token:\n" +
        "    1. Graph Application permission Mail.Send + admin consent  → `roles`\n" +
        "    2. Exchange Online RBAC for Applications                   → not in token\n" +
        `    3. A directory role assignment                             → \`wids\`${
          Array.isArray(claims.wids) && claims.wids.length
            ? ` (this token has ${claims.wids.length})`
            : ""
        }\n` +
        "\n  Prove it end to end:  npm run verify:graph -- --send you@example.com\n" +
        "\n  If sending DOES fail, grant it explicitly:\n" +
        "    Entra ID → App registrations → " +
        `${claims.appid}\n` +
        "    → API permissions → Add → Microsoft Graph → APPLICATION permissions\n" +
        "    → Mail.Send → Add → 'Grant admin consent'  (Delegated will NOT work)\n"
    );
  }

  // ── Optional: prove delivery by actually sending ──────────────────────────
  const sendIndex = process.argv.indexOf("--send");
  if (sendIndex !== -1) {
    const recipient = process.argv[sendIndex + 1] || sender;
    console.log(`\n  Sending a test message to ${maskEmail(recipient)} …`);

    const payload = JSON.stringify({
      message: {
        subject: "DataHub — Graph configuration test",
        body: {
          contentType: "Text",
          content:
            "This is an automated test from `npm run verify:graph -- --send`.\n" +
            "Receiving it confirms app-only Mail.Send works for this tenant.",
        },
        toRecipients: [{ emailAddress: { address: recipient } }],
      },
      saveToSentItems: false,
    });

    const status = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "graph.microsoft.com",
          path: `/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${payloadToken}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ code: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    if (status.code === 202) {
      ok("SEND succeeded — Graph accepted the message (202 Accepted)");
      console.log("    Mail.Send is genuinely working, whatever the roles claim says.");
    } else {
      bad(`SEND failed — HTTP ${status.code}`);
      console.log(`    ${status.body.slice(0, 300)}`);
      if (status.code === 403) {
        console.log(
          "\n    403 here IS conclusive: the app cannot send as this mailbox.\n" +
            "    Grant Microsoft Graph → Application permissions → Mail.Send and\n" +
            "    admin-consent it, or add an Exchange RBAC assignment for the app."
        );
      }
      process.exit(1);
    }
  }

  // ── Least-privilege advisory ──────────────────────────────────────────────
  const broad = roles.filter((r) => /^Mail\.ReadWrite|^Mail\.Read$|\.All$/.test(r));
  if (broad.length > 0) {
    warn(`Broader permissions than needed are granted: ${broad.join(", ")}`);
    console.log(
      "    Sending requires only Mail.Send. Remove the others, and scope the app\n" +
        "    to a single mailbox with an Application Access Policy:\n" +
        "      New-ApplicationAccessPolicy -AppId <client-id> \\\n" +
        "        -PolicyScopeGroupId <mail-enabled-security-group> \\\n" +
        "        -AccessRight RestrictAccess -Description 'DataHub noreply only'\n" +
        "    Without such a policy, Mail.Send permits sending as ANY user in the\n" +
        "    tenant — including executives."
    );
  } else {
    ok("Least privilege: only the permissions needed to send are granted");
  }

  console.log(`\n${GREEN}✓${RESET} Microsoft Graph email is correctly configured.\n`);
  process.exit(0);
})().catch((error) => {
  bad(`Unexpected: ${error.message}`);
  process.exit(1);
});
