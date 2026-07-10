const { generateFinancialStatements } = require('./src/services/keyReports/financialStatementService');
(async () => {
  const VID = '6922de61-b103-4af6-a668-d9a0dd170ece'; // Version 5 (has GL, COA empty until re-gen)
  try {
    let t = Date.now();
    const r1 = await generateFinancialStatements(VID, { currency: 'USD' });
    console.log(`call#1: ${Date.now()-t}ms | plMonthly=${r1.reports.profitAndLoss.monthly.length} missingData=${(r1.missingData||[]).length}`);
    t = Date.now();
    const r2 = await generateFinancialStatements(VID, { currency: 'USD' });
    console.log(`call#2: ${Date.now()-t}ms | plMonthly=${r2.reports.profitAndLoss.monthly.length}`);
    console.log('currency preserved:', r2.currency, '| no throw ✓');
  } catch (e) { console.error('ERROR:', e.message, e.stack); }
  process.exit(0);
})();
