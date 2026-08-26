/**
 * Schema drift reconciliation (staging-parity-harness, design D5).
 *
 * `db:pull` tells you what the database has; `packages/db/src/schema.ts` says what
 * we declared. The difference is drift — and the reason it needs a **committed
 * baseline** rather than a run log is that most of the drift is already known:
 * without a baseline every reconciliation re-derives the same long list of legacy
 * columns nobody has modelled yet, and a genuinely new difference is lost among
 * them.
 *
 * So: diff introspected against declared, subtract the baseline, and report what
 * is left. That residue is the only part anyone needs to look at.
 */

export interface TableShape {
  /** Column name → declared SQL type, lowercased. */
  [column: string]: string;
}

export interface SchemaShape {
  [table: string]: TableShape;
}

export type DriftKind =
  | "table-missing-from-declaration"
  | "table-missing-from-database"
  | "column-missing-from-declaration"
  | "column-missing-from-database"
  | "type-differs";

export interface DriftItem {
  kind: DriftKind;
  table: string;
  column?: string;
  database?: string;
  declared?: string;
}

/** Stable key so a baseline entry matches the item it was recorded for. */
export function driftKey(item: DriftItem): string {
  return [item.kind, item.table, item.column ?? ""].join("|");
}

/**
 * Compare an introspected schema against the declared one.
 *
 * Direction matters and is reported explicitly: a table in the database that we
 * have not modelled is *backlog* (most of the legacy schema), while a table we
 * declared that the database lacks is a *bug* — the module would fail at runtime.
 * Collapsing both into "different" would bury the second in the first.
 */
export function diffSchemas(database: SchemaShape, declared: SchemaShape): DriftItem[] {
  const items: DriftItem[] = [];
  const tables = new Set([...Object.keys(database), ...Object.keys(declared)]);

  for (const table of [...tables].sort()) {
    const dbTable = database[table];
    const declaredTable = declared[table];

    if (!declaredTable) {
      items.push({ kind: "table-missing-from-declaration", table });
      continue;
    }
    if (!dbTable) {
      items.push({ kind: "table-missing-from-database", table });
      continue;
    }

    const columns = new Set([...Object.keys(dbTable), ...Object.keys(declaredTable)]);
    for (const column of [...columns].sort()) {
      const dbType = dbTable[column];
      const declaredType = declaredTable[column];
      if (dbType === undefined) {
        items.push({ kind: "column-missing-from-database", table, column, declared: declaredType });
      } else if (declaredType === undefined) {
        items.push({ kind: "column-missing-from-declaration", table, column, database: dbType });
      } else if (normalizeType(dbType) !== normalizeType(declaredType)) {
        items.push({ kind: "type-differs", table, column, database: dbType, declared: declaredType });
      }
    }
  }

  return items;
}

/** Postgres spells the same type several ways; those are not drift. */
export function normalizeType(type: string): string {
  const t = type.trim().toLowerCase().replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "character varying": "varchar",
    "double precision": "float8",
    int4: "integer",
    int8: "bigint",
    int: "integer",
    bool: "boolean",
    serial4: "integer",
  };
  return aliases[t] ?? t;
}

export interface DriftBaseline {
  recordedAt: string;
  source: string;
  /** Keys of drift items that were triaged and accepted when the baseline was taken. */
  accepted: string[];
}

export interface DriftReport {
  baseline: DriftBaseline | null;
  /** Drift already present in the baseline — known, triaged, not news. */
  known: DriftItem[];
  /** Drift that appeared since the baseline. This is the part to act on. */
  fresh: DriftItem[];
}

export function reconcile(
  database: SchemaShape,
  declared: SchemaShape,
  baseline: DriftBaseline | null,
): DriftReport {
  const items = diffSchemas(database, declared);
  if (!baseline) return { baseline: null, known: [], fresh: items };

  const accepted = new Set(baseline.accepted);
  return {
    baseline,
    known: items.filter((i) => accepted.has(driftKey(i))),
    fresh: items.filter((i) => !accepted.has(driftKey(i))),
  };
}

/** Build a baseline from the current difference — the "we have looked at all of this" record. */
export function baselineFrom(
  database: SchemaShape,
  declared: SchemaShape,
  source: string,
  recordedAt: string,
): DriftBaseline {
  return {
    recordedAt,
    source,
    accepted: diffSchemas(database, declared).map(driftKey).sort(),
  };
}

const KIND_LABEL: Record<DriftKind, string> = {
  "table-missing-from-declaration": "in the database, not modelled (backlog)",
  "table-missing-from-database": "declared, ABSENT FROM THE DATABASE (breaks at runtime)",
  "column-missing-from-declaration": "column in the database, not modelled (backlog)",
  "column-missing-from-database": "column declared, ABSENT FROM THE DATABASE (breaks at runtime)",
  "type-differs": "type differs",
};

/** Drift that will break a module at runtime, as opposed to drift that is backlog. */
export function isBreaking(item: DriftItem): boolean {
  return (
    item.kind === "table-missing-from-database" ||
    item.kind === "column-missing-from-database" ||
    item.kind === "type-differs"
  );
}

export function renderDrift(report: DriftReport): string {
  const lines: string[] = [];
  lines.push(
    report.baseline
      ? `Drift vs baseline recorded ${report.baseline.recordedAt} (${report.baseline.source})`
      : "Drift with NO baseline recorded — everything below is reported as new.",
  );
  lines.push("");

  const breaking = report.fresh.filter(isBreaking);
  const backlog = report.fresh.filter((i) => !isBreaking(i));

  lines.push(`New drift: ${report.fresh.length} (${breaking.length} breaking)`);
  for (const item of breaking) {
    lines.push(
      `  ✗ ${item.table}${item.column ? `.${item.column}` : ""} — ${KIND_LABEL[item.kind]}` +
        (item.declared || item.database
          ? ` (declared ${item.declared ?? "—"}, database ${item.database ?? "—"})`
          : ""),
    );
  }
  for (const item of backlog) {
    lines.push(`  · ${item.table}${item.column ? `.${item.column}` : ""} — ${KIND_LABEL[item.kind]}`);
  }
  lines.push("");
  lines.push(`Known drift carried by the baseline: ${report.known.length} (not shown)`);
  return lines.join("\n");
}
