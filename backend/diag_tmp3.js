const { supabase } = require('./src/lib/supabaseClient');
const V='77de9cac-1348-47ea-b5ee-9e52ae352d8c';
(async () => {
  const { data } = await supabase.from('key_report_sync_logs').select('id,sync_status,sync_started_at,sync_completed_at,error_message').eq('version_id',V).order('sync_started_at',{ascending:false}).limit(5);
  console.log(JSON.stringify(data,null,1));
  // progress store?
  const { data: prog, error } = await supabase.from('key_report_progress').select('*').eq('version_id',V).maybeSingle();
  console.log('progress:', JSON.stringify(prog), error&&error.message);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
