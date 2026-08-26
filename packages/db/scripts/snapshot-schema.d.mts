/**
 * Types for the snapshot generator.
 *
 * The script itself stays `.mjs` because it is run directly by `db:snapshot`
 * with no build step. This declaration is what lets `schema-snapshot.test.ts`
 * import it under `tsc` instead of pulling in an implicit `any`.
 */

/** Absolute path of the committed snapshot. */
export declare const SNAPSHOT_PATH: string;

/** Repo-relative paths of every SQL file the snapshot is built from. */
export declare function sourceFiles(): string[];

/** sha256 over the source SQL, so a stale snapshot cannot pass unnoticed. */
export declare function sourceHash(): string;

/** Strip the parts of a `pg_dump` that vary between runs. */
export declare function normalize(dump: string): string;
