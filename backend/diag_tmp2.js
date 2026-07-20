const { generateFinancialStatements } = require('./src/services/keyReports/financialStatementService');
const V='77de9cac-1348-47ea-b5ee-9e52ae352d8c';
(async () => {
  for (let i=0;i<3;i++){
    const r = await generateFinancialStatements(V,{currency:'USD',noCache:true});
  }
})().then(()=>process.exit(0)).catch(e=>{console.error('ERR',e.message);process.exit(1)});
