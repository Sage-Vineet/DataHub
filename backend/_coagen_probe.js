const { generateChartOfAccounts, finalizeCoaHierarchy } = require('./src/services/chartOfAccountsService');
(async () => {
  const COMPANY = '746cec95-7da6-4298-a630-608246d2a91c';
  const VID = '6922de61-b103-4af6-a668-d9a0dd170ece';
  console.log('GEMINI_API_KEY set:', !!process.env.GEMINI_API_KEY, '| GOOGLE_API_KEY set:', !!process.env.GOOGLE_API_KEY);
  try {
    const summary = await generateChartOfAccounts(COMPANY, VID, null);
    await finalizeCoaHierarchy(COMPANY, VID);
    console.log('generateChartOfAccounts summary:', JSON.stringify(summary, null, 2));
  } catch (e) {
    console.error('COA GEN ERROR:', e.message, '\n', e.stack);
  }
  process.exit(0);
})();