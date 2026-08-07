"use strict";

/**
 * REMOVED — this module previously exported CLIENT_STATIC_PASSWORD, a single
 * shared password (defaulting to "123456") that authenticated EVERY client and
 * buyer account in the system. One guess compromised every customer tenant.
 *
 * Client accounts are now provisioned with an independent random password that
 * is never transmitted, and are flagged `must_change_password`. The holder
 * gains access through the email-verified password-reset flow.
 *
 * The export is retained as a throwing getter so any missed call site fails
 * loudly at runtime rather than silently reintroducing a shared credential.
 */

module.exports = Object.defineProperty({}, "CLIENT_STATIC_PASSWORD", {
  enumerable: true,
  get() {
    throw new Error(
      "CLIENT_STATIC_PASSWORD has been removed. Shared static passwords are not " +
        "permitted. Provision accounts with generateStrongPassword() from " +
        "security/passwordPolicy and require a password reset."
    );
  },
});
