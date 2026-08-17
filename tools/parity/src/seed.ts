/**
 * Seed-time anonymization for a staging environment restored from a production
 * snapshot, plus the staging marker the harness refuses to run without.
 *
 * The hazard being addressed is narrower and worse than "production data sits in a
 * lower environment": **staging runs a real Graph emailer**. A password-reset test,
 * a notification loop, or a stray job sends real mail to real customers from a
 * system nobody is watching. Masking in the application layer does not prevent
 * that — the address has to be wrong in the database.
 *
 * Financial data is deliberately NOT anonymized. Production-shaped rows and volumes
 * are the entire reason for taking a snapshot, and parity comparison is about those
 * shapes. That trade-off is stated in the change proposal and needs the CTO's
 * explicit sign-off before the first snapshot is taken.
 */

export interface AnonymizeOptions {
  /** Domain that accepts and retains mail, so reset flows stay checkable. */
  sinkDomain: string;
}

/**
 * Rewrite an address to a sink address that encodes the original row id, so a
 * tester can still find "the mail for user X" without the address reaching anyone.
 */
export function sinkAddressFor(rowId: string, options: AnonymizeOptions): string {
  const safe = rowId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return `user-${safe}@${options.sinkDomain}`;
}

/** A recognisably fake, non-routable number in the reserved 555-01xx range. */
export function placeholderPhone(rowId: string): string {
  const digits = rowId.replace(/\D/g, "").padEnd(4, "0");
  return `+1555010${digits.slice(0, 4)}`;
}

/** True when a value still looks like real contact data after a seed. */
export function looksLikeProductionContact(value: string | null, options: AnonymizeOptions): boolean {
  if (!value) return false;
  if (value.includes("@")) return !value.endsWith(`@${options.sinkDomain}`);
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) return !digits.startsWith("1555010");
  return false;
}

function assertIdentifier(name: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`refusing to interpolate an unsafe identifier: ${name}`);
  }
}

export interface ContactColumn {
  table: string;
  idColumn: string;
  emailColumns?: string[];
  phoneColumns?: string[];
}

/**
 * Every table holding contact data that could reach a person. Derived by hand from
 * the schema; a table missing here is an address that survives the seed, so this
 * list is asserted against the declared schema in the tests.
 */
export const CONTACT_COLUMNS: ReadonlyArray<ContactColumn> = [
  { table: "users", idColumn: "id", emailColumns: ["email"], phoneColumns: ["phone"] },
  {
    table: "companies",
    idColumn: "id",
    emailColumns: ["contact_email"],
    phoneColumns: ["contact_phone"],
  },
];

/**
 * SQL that rewrites every contact identifier in place. Runs as part of the seed —
 * not as a follow-up step someone can forget, which is the same class of mistake as
 * a partition nobody rolled forward.
 */
export function anonymizeContactsSql(options: AnonymizeOptions): string {
  if (!/^[a-zA-Z0-9.-]+$/.test(options.sinkDomain)) {
    throw new Error(`refusing to interpolate an unsafe sink domain: ${options.sinkDomain}`);
  }
  const statements: string[] = [];
  for (const spec of CONTACT_COLUMNS) {
    assertIdentifier(spec.table);
    assertIdentifier(spec.idColumn);
    const sets: string[] = [];
    for (const column of spec.emailColumns ?? []) {
      assertIdentifier(column);
      sets.push(
        `${column} = CASE WHEN ${column} IS NULL THEN NULL ELSE ` +
          `'user-' || regexp_replace(${spec.idColumn}::text, '[^a-zA-Z0-9]', '', 'g') || ` +
          `'@${options.sinkDomain}' END`,
      );
    }
    for (const column of spec.phoneColumns ?? []) {
      assertIdentifier(column);
      sets.push(
        `${column} = CASE WHEN ${column} IS NULL THEN NULL ELSE ` +
          `'+1555010' || lpad(left(regexp_replace(${spec.idColumn}::text, '\\D', '', 'g'), 4), 4, '0') END`,
      );
    }
    if (sets.length > 0) {
      statements.push(`UPDATE ${spec.table} SET ${sets.join(", ")};`);
    }
  }
  return statements.join("\n");
}

/**
 * The marker the harness refuses to run without. Written by the seed, so an
 * environment nobody seeded — a restored snapshot, a local copy — is not a valid
 * target no matter what its connection string says.
 */
export function stagingMarkerSql(source: string, seededAt: string): string {
  return `
CREATE TABLE IF NOT EXISTS staging_marker (
  id integer PRIMARY KEY,
  seeded_at timestamptz NOT NULL,
  source text NOT NULL
);
DELETE FROM staging_marker;
INSERT INTO staging_marker (id, seeded_at, source)
  VALUES (1, '${seededAt}', ${quote(source)});
`.trim();
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The full seed, in the order it must run. */
export function seedSql(options: {
  sinkDomain: string;
  source: string;
  seededAt: string;
}): string {
  return [
    "BEGIN;",
    anonymizeContactsSql({ sinkDomain: options.sinkDomain }),
    stagingMarkerSql(options.source, options.seededAt),
    "COMMIT;",
  ].join("\n");
}
