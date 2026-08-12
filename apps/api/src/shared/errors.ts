/** An error carrying an HTTP status; domain routers map `.status` to the response. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "You do not have access to this resource.") {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found.") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message = "Bad request.") {
    super(400, message);
    this.name = "BadRequestError";
  }
}
