/** An error carrying an HTTP status; the router maps `.status` to the response. */
export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super(401, "Invalid credentials");
    this.name = "InvalidCredentialsError";
  }
}
