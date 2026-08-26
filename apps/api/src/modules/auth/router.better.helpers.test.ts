import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { errorStatus, forwardSetCookie } from "./router.better.js";

/**
 * The two normalisers between Better Auth and Express.
 *
 * Small, and each decides something a caller acts on: which STATUS a library
 * error becomes, and whether a session cookie reaches the browser at all.
 * (Validation messages are `shared/first-error.ts`, which every router shares.)
 */

describe("normalising a library error into a status", () => {
  it("takes statusCode, which is what Better Auth's APIError carries", () => {
    expect(errorStatus({ statusCode: 429, message: "Too many requests" })).toEqual({
      status: 429,
      message: "Too many requests",
    });
  });

  it("takes status, which some throws carry instead", () => {
    // Getting this wrong turns a 429 into a 400, and the client retries
    // immediately instead of backing off.
    expect(errorStatus({ status: 403, message: "Forbidden" }).status).toBe(403);
  });

  it("prefers the body's message over the error's own", () => {
    // The body is what the library meant to say; `message` is often the
    // transport's summary of it.
    expect(
      errorStatus({ statusCode: 400, body: { message: "Code expired." }, message: "Bad Request" })
        .message,
    ).toBe("Code expired.");
  });

  it("falls back to 400 for an error carrying no status at all", () => {
    // A 500 sends somebody looking for a fault in the server; the common case
    // here is a request the library refused.
    expect(errorStatus(new Error("something went wrong"))).toEqual({
      status: 400,
      message: "something went wrong",
    });
  });

  it("says something rather than nothing for an error with no message", () => {
    expect(errorStatus({})).toEqual({ status: 400, message: "Request failed." });
  });

  it("ignores a status that is not a number", () => {
    expect(errorStatus({ statusCode: "429", status: "403" }).status).toBe(400);
  });
});

describe("forwarding the session cookie", () => {
  it("copies every cookie the library set", () => {
    // Both are needed on a login that rotates: one clears the old session and
    // one sets the new. Copying only the first leaves the browser holding a
    // session the server has already forgotten.
    const setHeader = vi.fn();
    const headers = new Headers();
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "old=; Max-Age=0");

    forwardSetCookie(headers, { setHeader } as unknown as Response);
    expect(setHeader).toHaveBeenCalledWith("set-cookie", [
      "session=abc; Path=/; HttpOnly",
      "old=; Max-Age=0",
    ]);
  });

  it("sets no header when the library set no cookie", () => {
    // An empty `set-cookie` header is not the same as none: some clients treat
    // it as a directive to clear.
    const setHeader = vi.fn();
    forwardSetCookie(new Headers(), { setHeader } as unknown as Response);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("sets no header on a runtime whose Headers cannot enumerate cookies", () => {
    // `getSetCookie` is recent. Older runtimes have no way to read repeated
    // headers, and guessing from `get("set-cookie")` would join them with a
    // comma and produce one malformed cookie.
    const setHeader = vi.fn();
    forwardSetCookie({} as unknown as Headers, { setHeader } as unknown as Response);
    expect(setHeader).not.toHaveBeenCalled();
  });
});
