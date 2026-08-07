"use strict";

/**
 * Request validation and sanitisation.
 *
 * WHY schema validation at the edge rather than checks inside handlers:
 *   • It is allowlist-based. A handler that checks "is email present" still
 *     receives every other field the attacker chose to send; a schema strips
 *     them. That closes mass-assignment (a POST with `"role": "admin"` in the
 *     body silently promoting the caller).
 *   • It enforces types before any value reaches a query builder. Supabase and
 *     `pg` both parameterise, so classic string-concatenation SQL injection is
 *     already off the table — but PostgREST filter operators are string-driven,
 *     and an unvalidated `?order=` or `?select=` value can still be abused to
 *     read columns the endpoint never intended to expose.
 *   • It bounds size. Unbounded arrays and strings are a cheap DoS.
 *
 * Prototype pollution: `__proto__`, `constructor` and `prototype` keys are
 * stripped from every parsed body before validation. Express's JSON parser will
 * happily produce them, and a single `Object.assign(target, req.body)` anywhere
 * downstream then poisons the global prototype.
 */

const { z } = require("zod");
const { AppError } = require("./error");

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_OBJECT_DEPTH = 12;

/** Recursively removes prototype-pollution keys and enforces a depth ceiling. */
function stripDangerousKeys(value, depth = 0) {
  if (depth > MAX_OBJECT_DEPTH) {
    throw new AppError("Request structure is too deeply nested.", {
      status: 400,
      code: "PAYLOAD_TOO_DEEP",
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeys(item, depth + 1));
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const output = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      output[key] = stripDangerousKeys(entry, depth + 1);
    }
    // Return a plain object so downstream code that expects one still works.
    return Object.assign({}, output);
  }
  return value;
}

/** Global body sanitiser — mount once, immediately after the JSON parser. */
function sanitizeBody(req, _res, next) {
  try {
    if (req.body && typeof req.body === "object") {
      req.body = stripDangerousKeys(req.body);
    }
    if (req.query && typeof req.query === "object") {
      // req.query is a getter on newer Express; mutate in place.
      for (const key of Object.keys(req.query)) {
        if (DANGEROUS_KEYS.has(key)) delete req.query[key];
      }
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Builds a validation middleware.
 *
 * The parsed, coerced, stripped result REPLACES req.body / req.query / req.params,
 * so a handler physically cannot read a field the schema did not declare.
 *
 * @param {{ body?: import('zod').ZodType, query?: import('zod').ZodType, params?: import('zod').ZodType }} schemas
 */
function validate(schemas = {}) {
  return (req, _res, next) => {
    const issues = [];

    for (const source of ["params", "query", "body"]) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source] ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            field: `${source}.${issue.path.join(".") || "(root)"}`,
            // Zod messages describe the constraint, not the submitted value, so
            // they are safe to return.
            message: issue.message,
          });
        }
        continue;
      }

      // req.query and req.params are getter-only in Express 5; assign safely.
      try {
        req[source] = result.data;
      } catch {
        Object.defineProperty(req, source, { value: result.data, writable: true });
      }
    }

    if (issues.length > 0) {
      return next(
        new AppError("Validation failed.", {
          status: 400,
          code: "VALIDATION_ERROR",
          details: issues.slice(0, 20),
        })
      );
    }
    return next();
  };
}

// ── Reusable primitives ─────────────────────────────────────────────────────

const uuid = z.string().uuid("Must be a valid identifier.");

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .email("Must be a valid email address.");

/** Free text with a hard length cap and control characters removed. */
const text = (max = 255, { min = 0 } = {}) =>
  z
    .string()
    // Strip C0/C1 control characters (tab and newline excepted) — they serve no
    // purpose in user text and enable log injection and CSV formula smuggling.
    .transform((value) => value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim())
    .pipe(z.string().min(min).max(max));

/** Loose international phone format — digits, spaces and common separators. */
const phone = z
  .string()
  .trim()
  .max(32)
  .regex(/^[+]?[\d\s().-]{6,32}$/, "Must be a valid phone number.")
  .optional()
  .nullable();

/** ISO date (YYYY-MM-DD). Rejects anything Date.parse would guess at. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD.")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Must be a real date.");

/** Accounting period, e.g. 2026-03. */
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Must be YYYY-MM.");

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

/**
 * A sort field restricted to an explicit allowlist.
 *
 * WHY: passing a raw client string into a PostgREST `.order()` call lets the
 * caller order by — and thereby infer the contents of — columns the endpoint
 * does not return. Always bind sorting to a closed set.
 */
const sortField = (allowed) =>
  z.enum(allowed).optional().catch(undefined);

const sortDirection = z.enum(["asc", "desc"]).default("asc");

/**
 * Search text destined for a PostgREST `ilike`/`or` filter.
 *
 * Strips the characters PostgREST treats as structural (`,` `.` `(` `)` `*`
 * `%` `\`), which is what stops a search box from being turned into an
 * arbitrary filter expression against other columns.
 */
const searchTerm = z
  .string()
  .trim()
  .max(120)
  .transform((value) => value.replace(/[,.()*%\\"']/g, " ").replace(/\s+/g, " ").trim());

/**
 * Strict boolean from a query string — `"false"` is falsy, unlike Boolean().
 */
const queryBoolean = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

/** Rejects a body with unexpected keys outright rather than stripping silently. */
function strictObject(shape) {
  return z.object(shape).strict();
}

module.exports = {
  z,
  validate,
  sanitizeBody,
  stripDangerousKeys,
  schemas: {
    uuid,
    email,
    text,
    phone,
    isoDate,
    yearMonth,
    pagination,
    sortField,
    sortDirection,
    searchTerm,
    queryBoolean,
    strictObject,
  },
};
