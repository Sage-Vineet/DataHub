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

  // Name the engagement after the company it is being loaded into.
  //
  // `engagementFixture.company.name` is the anonymized name the golden suite
  // asserts on, and it is NOT this demo's company. Using it here put a second,
  // real-sounding company's name in Acme Manufacturing's version selector on
  // four financial screens, and on a file in Acme's Financials folder. The rows
  // were correctly owned — it was only the label — but on a projector that is
  // indistinguishable from one customer seeing another's data, which is the
  // worst thing a multi-tenant product can appear to do.
  const { rows: companyRows } = await client.query(
    `SELECT name FROM companies WHERE id = $1`,
    [COMPANY_ID],
  );
  if (!companyRows[0]) {
    throw new Error("Run tools/demo/seed.sql first — the QoE seed needs its company to exist.");
  }
  const companyName = companyRows[0].name;

  await client.query(
    // `last_synced_at` is what opens the Chart of Accounts step in the wizard —
    // this version genuinely is synced, so it carries the timestamp.
    `INSERT INTO key_report_versions (id, company_id, version_number, version_name, status, is_active, last_synced_at)
     VALUES ($1, $2, 1, $3, 'synced', true, now())
     ON CONFLICT (id) DO UPDATE SET version_name = EXCLUDED.version_name,
       is_active = true, last_synced_at = now()`,
    [VERSION_ID, COMPANY_ID, `${companyName} — QoE`],
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
    // A stated size, not '0'. A zero-byte document renders in the file list as
    // "0 B" with no failed-upload indicator, so a seeded artifact reads as a
    // broken one. This row stands in for a real multi-year GL export; size it
    // like one.
    `INSERT INTO documents (id, company_id, folder_id, name, file_url, size, ext, status, uploaded_by)
     VALUES ($1, $2, $3, $4, '', '2411008', 'xlsx', 'verified', $5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, size = EXCLUDED.size`,
    [
      SOURCE_FILE_ID,
      COMPANY_ID,
      folders[0].id,
      `${companyName} — General Ledger 2022-2025.xlsx`,
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

  // ── add-backs: the exhibit the bridge is named after ──────────────────────
  /**
   * Without these the EBITDA bridge opens with Adjusted EBITDA identical to
   * Reported EBITDA — the same number twice in the header and an empty middle.
   * The accounts, vendors and amounts below are all drawn from the seeded
   * ledger, so every figure on screen can be traced to a transaction rather
   * than being a decoration.
   *
   * Six add-backs in two groups, plus owner compensation, which the bridge
   * lifts out of the groups and renders as its own line because it is the sole
   * structural difference between Adjusted EBITDA and SDE.
   *
   * All of them are `company_financials`. The Tax Return toggle deliberately
   * has none: fabricating a second engagement would make the toggle look
   * substantive while the underlying ledger is unchanged, which is a claim the
   * demo should not make. The toggle staying visibly empty is the honest
   * behaviour, and it is in the presenter's script.
   */
  const MARKET_RATE_REPLACEMENT = 95_000;
  const RENT_POST_CLOSE = 216_000;

  // One replacement salary for the whole engagement. Adjusted EBITDA adds owner
  // compensation back NET of this; SDE adds it back in full. Without it the
  // owner line is labelled "net of market-rate replacement" and nets nothing.
  await client.query(
    `UPDATE companies SET market_rate_replacement_salary = $2 WHERE id = $1`,
    [COMPANY_ID, MARKET_RATE_REPLACEMENT],
  );

  const account = (slug) => {
    const id = accountId.get(slug);
    if (!id) throw new Error(`Add-back seed references an unknown account: ${slug}`);
    return id;
  };

  const addbacks = [
    {
      kind: "manual_adjustment",
      typeKey: "officer_compensation",
      name: "Owner's salary and discretionary bonus",
      values: { 2022: 165_000, 2023: 172_000, 2024: 180_000, 2025: 185_000 },
      explanation:
        "Owner's W-2 salary and year-end discretionary bonus, added back in full and netted " +
        `against a market-rate replacement salary of $${MARKET_RATE_REPLACEMENT.toLocaleString()}.`,
      commentary:
        "The owner works full time in the business. A buyer would hire a general manager at " +
        "market rate, so only the excess over that rate is an adjustment.",
    },

    // ── discretionary and personal ──
    {
      kind: "pnl_account_vendor",
      typeKey: "personal_expense",
      name: "Owner's personal vehicle costs",
      linkedAccount: "car-truck",
      // Scoped to the four vendors carrying the owner's vehicles. The rest of
      // Car & Truck is the delivery fleet and stays in the business.
      vendorScope: ["Vendor 052", "Vendor 078", "Vendor 102", "Vendor 108"],
      groupId: "g-discretionary",
      groupLabel: "Owner & Discretionary",
      commentary: "Lease, fuel and maintenance on two vehicles used personally by the owner's family.",
    },
    {
      kind: "pnl_account_vendor",
      typeKey: "personal_expense",
      name: "Meals & entertainment",
      linkedAccount: "meals-entertainment",
      groupId: "g-discretionary",
      groupLabel: "Owner & Discretionary",
      commentary: "Treated as wholly discretionary; the business does not entertain customers.",
    },
    {
      kind: "pnl_account_vendor",
      typeKey: "other_addback",
      name: "Charitable contributions",
      linkedAccount: "charitable-contributions",
      groupId: "g-discretionary",
      groupLabel: "Owner & Discretionary",
      commentary: "Local sponsorships at the owner's discretion, not required to operate.",
    },
    {
      kind: "recast",
      typeKey: "related_party_rent",
      name: "Related-party rent above market",
      linkedAccount: "rent-lease",
      recastNormalizedValue: RENT_POST_CLOSE,
      groupId: "g-discretionary",
      groupLabel: "Owner & Discretionary",
      commentary:
        `The premises are owned by an affiliate of the seller. A market lease is $${RENT_POST_CLOSE.toLocaleString()} ` +
        "per year; the add-back is the excess actually paid.",
    },

    // ── non-recurring ──
    {
      kind: "manual_adjustment",
      typeKey: "non_recurring_charge",
      name: "Legal fees — ownership dispute",
      values: { 2023: 12_400, 2024: 18_500 },
      groupId: "g-nonrecurring",
      groupLabel: "Non-recurring Items",
      explanation:
        "Fees for a shareholder dispute settled in 2024. Confirmed with counsel as concluded, " +
        "with no further amounts expected.",
      commentary: "Concluded matter; does not recur for a buyer.",
    },
    {
      kind: "manual_adjustment",
      typeKey: "other_addback",
      name: "Gain on sale of surplus equipment",
      values: { 2022: -38_400 },
      groupId: "g-nonrecurring",
      groupLabel: "Non-recurring Items",
      explanation:
        "One-off gain on disposal of surplus arcade equipment in 2022. Removed from earnings " +
        "because it is not operating income.",
      commentary: "A negative adjustment: non-recurring income comes out of the bridge.",
    },
  ];

  for (const a of addbacks) {
    await client.query(
      `INSERT INTO qoe_addbacks
         (company_id, version_id, kind, data_source, type_key, name, linked_account_id,
          vendor_scope, granularity, values, recast_normalized_value,
          group_id, group_label, explanation, commentary, created_by)
       VALUES ($1,$2,$3,'company_financials',$4,$5,$6,$7,'detail',$8,$9,$10,$11,$12,$13,$14)`,
      [
        COMPANY_ID,
        VERSION_ID,
        a.kind,
        a.typeKey,
        a.name,
        a.linkedAccount ? account(a.linkedAccount) : null,
        JSON.stringify(a.vendorScope ?? []),
        JSON.stringify(a.values ?? {}),
        a.recastNormalizedValue ?? null,
        a.groupId ?? null,
        a.groupLabel ?? null,
        a.explanation ?? null,
        a.commentary ?? null,
        uploaders[0].id,
      ],
    );
  }

  await client.query("COMMIT");

  const bsRows = engagementFixture.balanceSheets.reduce((n, s) => n + s.rows.length, 0);
  console.log(`qoe seed: ${engagementFixture.accounts.length} accounts, ${engagementFixture.glEntries.length} ledger rows, ${bsRows} balance-sheet rows`);
  console.log(`qoe seed: ${addbacks.length} add-backs, replacement salary $${MARKET_RATE_REPLACEMENT.toLocaleString()}`);
  console.log(`qoe seed: company ${COMPANY_ID}, version ${VERSION_ID}`);
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
