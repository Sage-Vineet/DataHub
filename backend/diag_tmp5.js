const { supabase } = require('./src/lib/supabaseClient');
(async () => {
  const comp = await supabase.from('companies').select('id',{count:'exact',head:true});
  console.log('companies count:', comp.count);
  const vers = await supabase.from('key_report_versions').select('id',{count:'exact',head:true});
  console.log('key_report_versions count:', vers.count);
  const coaGlobal = await supabase.from('chart_of_accounts').select('id',{count:'exact',head:true});
  console.log('chart_of_accounts GLOBAL count:', coaGlobal.count);
  const bsGlobal = await supabase.from('balance_sheet_entries').select('id',{count:'exact',head:true});
  console.log('balance_sheet_entries GLOBAL count:', bsGlobal.count);
  // per-version GL breakdown
  const seen={}; let from=0;
  for(;;){ const {data}=await supabase.from('general_ledger_entries').select('version_id').range(from,from+999);
    if(!data||!data.length)break; for(const r of data) seen[r.version_id]=(seen[r.version_id]||0)+1; if(data.length<1000)break; from+=1000; }
  console.log('GL by version (all):', JSON.stringify(seen));
})().then(()=>process.exit(0)).catch(e=>{console.error('CATCH',e.message);process.exit(1)});
