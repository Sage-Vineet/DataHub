// Combined schema barrel: business tables (schema.ts) + Better Auth identity
// tables (auth-schema.ts). This is the object handed to Drizzle at runtime so
// `db.query.authUser` / `db.query.session` / … exist for the Better Auth adapter.
// drizzle-kit reads the two source files directly (see drizzle.config.ts); it
// does not load this barrel, which keeps its CJS loader off the re-export path.
export * from "./schema.js";
export * from "./auth-schema.js";
export * from "./qoe-schema.js";
export * from "./dataroom-qa-schema.js";
