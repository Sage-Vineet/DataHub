import type { Emailer } from "./ports.js";

/**
 * Dev/stub emailer: logs that a code would be sent (and, outside production,
 * the code itself for local testing). The real Microsoft Graph adapter replaces
 * this later; the observable auth behavior (generic reset response) does not
 * depend on actual delivery.
 */
export class ConsoleEmailer implements Emailer {
  async sendOtp(email: string, otp: string): Promise<{ sent: boolean }> {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[auth][dev] OTP for <${email}>: ${otp}`);
    }
    return { sent: false };
  }
}
