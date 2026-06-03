"use strict";

const { supabase } = require("../db");

/**
 * Creates an in-app welcome notification for a newly created user.
 * Writes to the `user_notifications` table in Supabase.
 * Fails gracefully — user creation is never blocked by notification errors.
 *
 * @param {string} userId     - UUID of the newly created user
 * @param {object} createdBy  - The requester user object (broker/admin)
 * @returns {Promise<{ created: boolean, error?: string }>}
 */
async function createWelcomeNotification(userId, createdBy) {
  if (!userId) {
    return { created: false, error: "Missing userId" };
  }

  try {
    const { error } = await supabase.from("user_notifications").insert({
      user_id: userId,
      type: "welcome",
      title: "Account Created",
      message:
        "Your DataHub account has been set up. Login credentials have been sent to your email address.",
      is_read: false,
      created_by: createdBy?.id || null,
      created_at: new Date().toISOString(),
    });

    if (error) {
      // Table may not exist yet — log a warning but do not throw.
      console.warn(
        `[Notification Service] Could not create welcome notification for user ${userId}: ${error.message}`
      );
      return { created: false, error: error.message };
    }

    console.log(
      `[Notification Service] Welcome notification created for user ${userId}`
    );
    return { created: true };
  } catch (err) {
    console.warn(
      `[Notification Service] Unexpected error creating notification for user ${userId}: ${err.message}`
    );
    return { created: false, error: err.message };
  }
}

module.exports = { createWelcomeNotification };
