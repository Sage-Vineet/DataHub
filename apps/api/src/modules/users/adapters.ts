import type { AuthCachePort, EmailerPort, NotificationPort } from "./ports.js";

/**
 * Transitional port adapters (design D3). Welcome email + in-app notification are
 * best-effort and currently dev stubs — they become the real email/notification
 * services when those land. Auth-cache invalidation is a no-op because Better Auth
 * sessions are DB-backed (ADR-0007): an update is reflected on the next
 * `getSession` with nothing to bust.
 */

export class ConsoleEmailerPort implements EmailerPort {
  async sendWelcome(user: { email: string }): Promise<void> {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[users][dev] welcome email would be sent to <${user.email}>`);
    }
  }
}

export class ConsoleNotificationPort implements NotificationPort {
  async notifyUserCreated(newUserId: string, actorId: string): Promise<void> {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[users][dev] notify: ${actorId} created ${newUserId}`);
    }
  }
}

export class NoopAuthCachePort implements AuthCachePort {
  invalidate(_userId: string): void {
    // No cache to bust — Better Auth reads session state from the DB (ADR-0007).
  }
}
