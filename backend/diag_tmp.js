const { supabase } = require('./src/lib/supabaseClient');
const V='77de9cac-1348-47ea-b5ee-9e52ae352d8c';
const CID='de7e1366-fb90-40c1-bcc2-38efcf56f893';
const code = n => { const m=String(n||'').trim().match(/^(\d{3,7})\b/); return m?m[1]:null; };
const leaf = n => String(n||'').trim().split(':').pop().replace(/^\d{3,7}[\s\-.]+/,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

(async () => {
  for (const y of [2023,2024,2025]) {
    let from=0; const rows=[];
    for(;;){ const {data}=await supabase.from('general_ledger_entries').select('account_name,split_account,amount').eq('version_id',V).eq('company_id',CID)
      .gte('transaction_date',`${y}-01-01`).lte('transaction_date',`${y}-12-31`).or('row_type.eq.TRANSACTION,row_type.is.null').range(from,from+999);
      if(!data||!data.length)break; rows.push(...data); if(data.length<1000)break; from+=1000; }

    const codesWithOwn=new Set(), leavesWithOwn=new Set(), namesWithOwn=new Set();
    for (const r of rows){ const n=(r.account_name||'').trim(); if(!n)continue; namesWithOwn.add(n);
      const c=code(n); if(c)codesWithOwn.add(c); const l=leaf(n); if(l)leavesWithOwn.add(l); }

    let codeOnlySkipped=0, codeLeafSkipped=0, splitTotal_codeOnly=0, splitTotal_codeLeaf=0;
    for (const r of rows) {
      const s=(r.split_account||'').trim(); if(!s) continue;
      if (namesWithOwn.has(s)) continue;
      const sc=code(s), sl=leaf(s);
      const skipCodeOnly = sc && codesWithOwn.has(sc);
      const skipCodeLeaf = (sc && codesWithOwn.has(sc)) || (sl && leavesWithOwn.has(sl));
      if (!skipCodeOnly) splitTotal_codeOnly += Number(r.amount)||0; else codeOnlySkipped++;
      if (!skipCodeLeaf) splitTotal_codeLeaf += Number(r.amount)||0; else codeLeafSkipped++;
    }
    console.log(`FY${y}: split-fallback-included-total codeOnly=${splitTotal_codeOnly.toFixed(2)} (skipped ${codeOnlySkipped})  codeLeaf=${splitTotal_codeLeaf.toFixed(2)} (skipped ${codeLeafSkipped})`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
