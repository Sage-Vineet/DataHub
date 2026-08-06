"use strict";

const { supabase } = require("../db");

async function createUserNotification({
  userId,
  type = "general",
  title,
  message,
  createdBy = null,
  metadata = {},
}) {
  if (!userId) {
    return { created: false, error: "Missing userId" };
  }

  const payload = {
    user_id: userId,
    type,
    title: title || "Notification",
    message: message || "",
    is_read: false,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    created_by: createdBy || null,
    created_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from("user_notifications").insert(payload);
    if (!error) return { created: true };

    const fallbackPayload = { ...payload };
    delete fallbackPayload.metadata;
    const { error: fallbackError } = await supabase.from("user_notifications").insert(fallbackPayload);
    if (!fallbackError) return { created: true };

    console.warn(
      `[Notification Service] Could not create ${type} notification for user ${userId}: ${fallbackError.message}`
    );
    return { created: false, error: fallbackError.message };
  } catch (err) {
    console.warn(
      `[Notification Service] Unexpected error creating ${type} notification for user ${userId}: ${err.message}`
    );
    return { created: false, error: err.message };
  }
}

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
  const result = await createUserNotification({
    userId,
    type: "welcome",
    title: "Account Created",
    message: "Your DataHub account has been set up. Login credentials have been sent to your email address.",
    createdBy: createdBy?.id || null,
  });

  if (result.created) {
    console.log(
      `[Notification Service] Welcome notification created for user ${userId}`
    );
  }

  return result;
}

module.exports = { createUserNotification, createWelcomeNotification };
