/**
 * Backfill `chart_of_accounts.ebitda_role` across key-report versions.
 *
 * The EBITDA bridge reads a stored classification, and every version ingested
 * before that column existed has none — which shows on screen as Reported
 * EBITDA equal to net income with every P&L account listed as unclassified.
 * This applies the same classifier the API uses, so a backfilled version and a
 * freshly classified one are identical.
 *
 *   DATABASE_URL=postgres://… node classify-accounts.mjs [--apply] [--version <id>]
 *
 * Defaults to a DRY RUN. Nothing is written without --apply, because this
 * changes the earnings figure on every engagement it touches.
 *
 * Only high-confidence results are written. Low-confidence matches are reported
 * for a human to confirm in the UI, and accounts left out carry the reason.
 */
import pg from "pg";
import { classifyAccounts } from "@datahub/financial-engine";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyVersion = args[args.indexOf("--version") + 1];
const scoped = args.includes("--version") && onlyVersion ? onlyVersion : null;

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: versions } = await client.query(
    `SELECT DISTINCT c.version_id,
            count(*) FILTER (WHERE c.statement_type = 'profit_loss') AS pl_accounts,
            count(*) FILTER (WHERE c.ebitda_role IS NOT NULL)        AS already_classified
       FROM chart_of_accounts c
      WHERE ($1::uuid IS NULL OR c.version_id = $1::uuid)
      GROUP BY c.version_id
      ORDER BY c.version_id`,
    [scoped],
  );

  if (versions.length === 0) {
    console.log("No key-report versions with a chart of accounts.");
    process.exit(0);
  }

  console.log(`${apply ? "APPLYING" : "DRY RUN"} — ${versions.length} version(s)\n`);
  let totalApplied = 0;
  let totalSuggested = 0;

  for (const version of versions) {
    const { rows } = await client.query(
      `SELECT id, account_name, account_type, statement_type, ebitda_role
         FROM chart_of_accounts
        WHERE version_id = $1`,
      [version.version_id],
    );

    const report = classifyAccounts(
      rows.map((r) => ({
        id: r.id,
        name: r.account_name,
        statementType: r.statement_type === "profit_loss" ? "profit_loss" : "balance_sheet",
        accountType: r.account_type === "income" ? "income" : r.account_type === "expense" ? "expense" : null,
        ebitdaRole: r.ebitda_role,
      })),
    );

    // Only report a change where the stored value actually differs, so a
    // re-run reads as "nothing to do" rather than repeating its own work.
    const existing = new Map(rows.map((r) => [r.id, r.ebitda_role]));
    const changes = report.applied.filter((c) => existing.get(c.accountId) !== c.role);

    console.log(
      `version ${version.version_id}  ` +
        `${version.pl_accounts} P&L accounts, ${version.already_classified} already classified`,
    );
    for (const c of changes) console.log(`   + ${c.accountName} → ${c.role}`);
    for (const c of report.suggested) console.log(`   ? ${c.accountName} → ${c.role} (needs review)`);
    if (changes.length === 0 && report.suggested.length === 0) console.log("   (nothing to change)");

    if (apply && changes.length > 0) {
      await client.query("BEGIN");
      try {
        for (const c of changes) {
          await client.query(
            `UPDATE chart_of_accounts SET ebitda_role = $1, updated_at = now() WHERE id = $2`,
            [c.role, c.accountId],
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    totalApplied += changes.length;
    totalSuggested += report.suggested.length;
    console.log("");
  }

  console.log(
    `${apply ? "applied" : "would apply"} ${totalApplied} role(s); ` +
      `${totalSuggested} need review in the UI.`,
  );
  if (!apply && totalApplied > 0) console.log("Re-run with --apply to write.");
} finally {
  await client.end();
}
