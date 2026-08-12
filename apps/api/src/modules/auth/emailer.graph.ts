import type { Emailer } from "./ports.js";

/**
 * Microsoft Graph emailer (design D5) — the production `Emailer`. Mirrors the
 * legacy `emailService.js`: OAuth2 client-credentials token (cached until ~1 min
 * before expiry) + `POST /users/{sender}/sendMail`. `fetch` and `now` are
 * injectable so the adapter is unit-testable without hitting Azure.
 */
export interface GraphEmailerOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  sender: string;
  fromName?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class GraphEmailer implements Emailer {
  private readonly opts: Required<Omit<GraphEmailerOptions, "fetchFn" | "now" | "fromName">> & {
    fromName: string;
  };
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(options: GraphEmailerOptions) {
    if (!options.tenantId || !options.clientId || !options.clientSecret || !options.sender) {
      throw new Error(
        "Microsoft Graph not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_SENDER_EMAIL.",
      );
    }
    this.opts = {
      tenantId: options.tenantId,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      sender: options.sender,
      fromName: options.fromName ?? "DataHub",
    };
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Build a `GraphEmailer` from the environment, or throw if unconfigured. */
  static fromEnv(env: NodeJS.ProcessEnv): GraphEmailer {
    return new GraphEmailer({
      tenantId: env.GRAPH_TENANT_ID ?? "",
      clientId: env.GRAPH_CLIENT_ID ?? "",
      clientSecret: env.GRAPH_CLIENT_SECRET ?? "",
      sender: env.GRAPH_SENDER_EMAIL ?? "",
      fromName: env.EMAIL_FROM_NAME,
    });
  }

  async sendOtp(email: string, otp: string): Promise<{ sent: boolean }> {
    const subject = "Your DataHub verification code";
    const html =
      `<p>Your verification code is:</p>` +
      `<p style="font-size:24px;font-weight:bold;letter-spacing:3px">${otp}</p>` +
      `<p>This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>`;
    await this.deliver(email, subject, html);
    return { sent: true };
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.now() < this.tokenExpiresAt - 60_000) {
      return this.cachedToken;
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: "https://graph.microsoft.com/.default",
    });
    const res = await this.fetchFn(
      `https://login.microsoftonline.com/${this.opts.tenantId}/oauth2/v2.0/token`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    );
    const json = (await res.json()) as TokenResponse;
    if (!res.ok || !json.access_token) {
      throw new Error(`Graph token error: ${json.error_description ?? json.error ?? res.status}`);
    }
    this.cachedToken = json.access_token;
    this.tokenExpiresAt = this.now() + (Number(json.expires_in) || 3600) * 1000;
    return this.cachedToken;
  }

  private async deliver(to: string, subject: string, html: string): Promise<void> {
    const token = await this.getAccessToken();
    const payload = {
      message: {
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: to } }],
        from: { emailAddress: { address: this.opts.sender, name: this.opts.fromName } },
      },
      saveToSentItems: false,
    };
    const res = await this.fetchFn(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.opts.sender)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (res.status !== 202) {
      // Invalidate the cached token on auth errors so the next call re-fetches.
      if (res.status === 401) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
      }
      const text = await res.text().catch(() => "");
      throw new Error(`Graph sendMail failed — HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  }
}
