const db = require("../db");

let ensureTablePromise = null;

function parsePayload(value) {
  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

async function ensureWorkspacePageStateTable() {
  if (ensureTablePromise) {
    return ensureTablePromise;
  }

  ensureTablePromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS workspace_page_state (
        company_id text NOT NULL,
        page_key text NOT NULL,
        payload text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (company_id, page_key)
      )
    `);
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  return ensureTablePromise;
}

async function getWorkspacePageState(companyId, pageKey) {
  if (!companyId || !pageKey) return null;

  await ensureWorkspacePageStateTable();

  const result = await db.query(
    `
      SELECT company_id, page_key, payload, created_at, updated_at
      FROM workspace_page_state
      WHERE company_id = ? AND page_key = ?
    `,
    [companyId, pageKey],
  );

  const row = result?.rows?.[0];
  if (!row) return null;

  return {
    companyId: row.company_id,
    pageKey: row.page_key,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function replaceWorkspacePageState(companyId, pageKey, payload) {
  if (!companyId || !pageKey) {
    throw new Error("Missing companyId or pageKey while saving workspace state.");
  }

  await ensureWorkspacePageStateTable();

  await db.query(
    `DELETE FROM workspace_page_state WHERE company_id = ? AND page_key = ?`,
    [companyId, pageKey],
  );

  await db.query(
    `
      INSERT INTO workspace_page_state (
        company_id,
        page_key,
        payload,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    [companyId, pageKey, JSON.stringify(payload ?? {})],
  );

  return getWorkspacePageState(companyId, pageKey);
}

async function deleteWorkspacePageState(companyId, pageKey) {
  if (!companyId || !pageKey) return false;

  await ensureWorkspacePageStateTable();

  const existing = await getWorkspacePageState(companyId, pageKey);

  await db.query(
    `DELETE FROM workspace_page_state WHERE company_id = ? AND page_key = ?`,
    [companyId, pageKey],
  );

  return Boolean(existing);
}

module.exports = {
  ensureWorkspacePageStateTable,
  getWorkspacePageState,
  replaceWorkspacePageState,
  deleteWorkspacePageState,
};
