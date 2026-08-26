/**
 * The first validation problem, as a sentence somebody can act on.
 *
 * Structural rather than typed against a zod version: three routers needed
 * this and each had its own copy, and the shape of `ZodError` has changed
 * across majors more than once.
 *
 * The field is named when the message does not name it. Zod's default for a
 * missing field is the single word "Required", which reaches the page as
 * "Required" — true, unactionable, and identical whichever field is missing.
 */
export interface ValidationIssue {
  message?: string;
  path?: ReadonlyArray<string | number>;
}

export function firstError(err: { issues: ReadonlyArray<ValidationIssue> }): string {
  const issue = err.issues[0];
  const message = issue?.message?.trim();
  if (!message) return "Invalid request.";

  const field = issue?.path?.filter((part) => typeof part === "string").join(".");
  // Only when the message does not already say it: "Email is required." reads
  // worse as "email: Email is required."
  if (!field || message.toLowerCase().includes(field.toLowerCase())) return message;
  return `${field}: ${message}`;
}
