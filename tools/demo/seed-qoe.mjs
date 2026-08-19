/**
 * Seed the anonymized QoE engagement into the demo database.
 *
 * Loads the walkthrough engagement into the REAL tables the bridge reads —
 * `chart_of_accounts` and `general_ledger_entries` — so the demo exercises the
 * full path (ledger → repository → engine → HTTP → UI) rather than a fixture
 * shortcut. The figures on screen are the ones the golden suite asserts:
 *
 *   FY2024 net income        $47,568.23
 *   FY2024 Reported EBITDA  $347,403.35
 *
 * Idempotent: re-running replaces the engagement's rows.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { engagementFixture } from "@datahub/financial-engine";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

// Acme Manufacturing, from tools/demo/seed.sql — the broker persona's company.
const COMPANY_ID = process.env.QOE_DEMO_COMPANY_ID ?? "a0000000-0000-4000-8000-000000000001";
const VERSION_ID = process.env.QOE_DEMO_VERSION_ID ?? "d0000000-0000-4000-8000-000000000001";
const SOURCE_FILE_ID = "e0000000-0000-4000-8000-00000000000f";

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query("BEGIN");

  await client.query(
    // `last_synced_at` is what opens the Chart of Accounts step in the wizard —
    // this version genuinely is synced, so it carries the timestamp.
    `INSERT INTO key_report_versions (id, company_id, version_number, version_name, status, is_active, last_synced_at)
     VALUES ($1, $2, 1, $3, 'synced', true, now())
     ON CONFLICT (id) DO UPDATE SET version_name = EXCLUDED.version_name,
       is_active = true, last_synced_at = now()`,
    [VERSION_ID, COMPANY_ID, `${engagementFixture.company.name} — QoE`],
  );

  // Re-running the seed resets the engagement, add-backs included, so the demo
  // always opens from the same state.
  await client.query(`DELETE FROM qoe_addbacks WHERE version_id = $1`, [VERSION_ID]);
  await client.query(`DELETE FROM balance_sheet_entries WHERE version_id = $1`, [VERSION_ID]);
  await client.query(`DELETE FROM general_ledger_entries WHERE version_id = $1`, [VERSION_ID]);
  await client.query(`DELETE FROM chart_of_accounts WHERE version_id = $1`, [VERSION_ID]);

  // Every ledger row points at the document it was extracted from
  // (general_ledger_entries.source_file_id → documents). The demo stands up a
  // real document row rather than relaxing the constraint, so the seeded data
  // has the same referential shape as an actual upload.
  const { rows: folders } = await client.query(
    `SELECT id FROM folders WHERE company_id = $1 ORDER BY created_at LIMIT 1`,
    [COMPANY_ID],
  );
  const { rows: uploaders } = await client.query(
    `SELECT id FROM users WHERE company_id = $1 OR role IN ('broker','admin') ORDER BY role LIMIT 1`,
    [COMPANY_ID],
  );
  if (!folders[0] || !uploaders[0]) {
    throw new Error("Run tools/demo/seed.sql first — the QoE seed needs a folder and a user.");
  }
  await client.query(
    `INSERT INTO documents (id, company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
     VALUES ($1, $2, $3, $4, '', '0', 'xlsx', 'verified', $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      SOURCE_FILE_ID,
      COMPANY_ID,
      folders[0].id,
      `${engagementFixture.company.name} — General Ledger 2022-2025.xlsx`,
      uploaders[0].id,
    ],
  );

  // ── chart of accounts ─────────────────────────────────────────────────────
  const accountId = new Map();
  for (const account of engagementFixture.accounts) {
    const id = randomUUID();
    accountId.set(account.id, id);
    await client.query(
      // ebitda_role is deliberately NOT seeded. A freshly ingested engagement
      // has no classification; the demo runs the real classifier over it, which
      // is the step that has to work on a customer's chart of accounts.
      `INSERT INTO chart_of_accounts
         (id, version_id, company_id, account_name, account_type, statement_type, is_active, ebitda_role)
       VALUES ($1, $2, $3, $4, $5, $6, true, NULL)`,
      [id, VERSION_ID, COMPANY_ID, account.name, account.accountType, account.statementType],
    );
  }

  // ── general ledger ────────────────────────────────────────────────────────
  let id = Date.now() % 1_000_000_000;
  const CHUNK = 500;
  for (let i = 0; i < engagementFixture.glEntries.length; i += CHUNK) {
    const chunk = engagementFixture.glEntries.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((entry, n) => {
      const month = String(Math.min(Math.max(entry.month, 1), 12)).padStart(2, "0");
      const base = n * 10;
      values.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},` +
          `'TRANSACTION',$${base + 7},$${base + 8},$${base + 9},$${base + 10},'')`,
      );
      params.push(
        id++,
        VERSION_ID,
        COMPANY_ID,
        SOURCE_FILE_ID,
        `${entry.fiscalYear}-${month}-15`,
        entry.fiscalYear,
        accountId.get(entry.accountId),
        String(entry.amount),
        entry.vendor ?? null,
        entry.accountId,
      );
    });
    await client.query(
      `INSERT INTO general_ledger_entries
         (id, version_id, company_id, source_file_id, transaction_date, fiscal_year,
          row_type, coa_id, amount, vendor_name, account_name, account_number)
       VALUES ${values.join(",")}`,
      params,
    );
  }

  // ── balance-sheet statements, the roll-forward anchors ────────────────────
  // Stored exactly as the extractor writes them: plural section names, the
  // sub-heading each account sits under, and no subtotal rows.
  const PLURAL = { asset: "assets", liability: "liabilities", equity: "equity" };
  let bsId = (Date.now() % 1_000_000) * 100;
  for (const sheet of engagementFixture.balanceSheets) {
    const asOf = sheet.anchor === "starting" ? "2021-12-31" : "2025-12-31";
    for (const [order, row] of sheet.rows.entries()) {
      await client.query(
        `INSERT INTO balance_sheet_entries
           (id, version_id, company_id, source_file_id, as_of_date, fiscal_year,
            account_name, section, sub_section, amount, sort_order,
            hierarchy_level, is_total, is_generated, coa_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,false,false,$12)`,
        [
          bsId++,
          VERSION_ID,
          COMPANY_ID,
          SOURCE_FILE_ID,
          asOf,
          Number(asOf.slice(0, 4)),
          row.name,
          PLURAL[row.section] ?? row.section,
          row.group,
          String(row.amount),
          order,
          accountId.get(row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")) ?? null,
        ],
      );
    }
  }

  await client.query("COMMIT");

  const bsRows = engagementFixture.balanceSheets.reduce((n, s) => n + s.rows.length, 0);
  console.log(`qoe seed: ${engagementFixture.accounts.length} accounts, ${engagementFixture.glEntries.length} ledger rows, ${bsRows} balance-sheet rows`);
  console.log(`qoe seed: company ${COMPANY_ID}, version ${VERSION_ID}`);
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
