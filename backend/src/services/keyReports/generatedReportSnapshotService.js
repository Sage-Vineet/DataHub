const { supabase } = require('../../db');

const TABLE = 'generated_report_snapshots';

function isMissingSnapshotTable(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return text.includes('42p01') || text.includes('pgrst205') || text.includes(TABLE);
}

function scopeKey({ year, period } = {}) {
  const normalizedPeriod = period === 'month' ? 'month' : 'year';
  return year ? `${normalizedPeriod}:${Number(year)}` : `${normalizedPeriod}:all`;
}

async function getSnapshot(versionId, reportType, scope = {}) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('payload, generated_at')
    .eq('version_id', versionId)
    .eq('report_type', reportType)
    .eq('scope_key', scopeKey(scope))
    .maybeSingle();
  // Deployments can briefly run application code before migration 061. Annual
  // reports must still generate from GL during that window instead of failing.
  if (error && isMissingSnapshotTable(error)) return null;
  if (error) throw error;
  return data ? { ...data.payload, generatedAt: data.generated_at } : null;
}

async function replaceSnapshots(companyId, versionId, reportType, snapshots) {
  const { error: deleteError } = await supabase
    .from(TABLE)
    .delete()
    .eq('version_id', versionId)
    .eq('report_type', reportType);
  if (deleteError && isMissingSnapshotTable(deleteError)) return 0;
  if (deleteError) throw deleteError;

  const rows = snapshots.map(({ scope, payload }) => ({
    company_id: companyId,
    version_id: versionId,
    report_type: reportType,
    scope_key: scopeKey(scope),
    payload,
  }));
  if (!rows.length) return 0;
  const { error } = await supabase.from(TABLE).insert(rows);
  if (error) throw error;
  return rows.length;
}

module.exports = { getSnapshot, replaceSnapshots, scopeKey };
