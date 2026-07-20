const { supabase } = require('./src/lib/supabaseClient');
const V='77de9cac-1348-47ea-b5ee-9e52ae352d8c';
(async () => {
  const gl = await supabase.from('general_ledger_entries').select('id',{count:'exact',head:true}).eq('version_id',V);
  console.log('GL count:', gl.count, 'error:', gl.error && gl.error.message);
  const glGlobal = await supabase.from('general_ledger_entries').select('id',{count:'exact',head:true});
  console.log('GL GLOBAL count (all versions):', glGlobal.count);
  const coa = await supabase.from('chart_of_accounts').select('id',{count:'exact',head:true}).eq('version_id',V);
  console.log('COA count:', coa.count, 'error:', coa.error && coa.error.message);
})().then(()=>process.exit(0)).catch(e=>{console.error('CATCH',e.message);process.exit(1)});
