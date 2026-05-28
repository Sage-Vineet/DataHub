const fs = require('fs');
const path = require('path');

const filePath = 'd:/Company/DataHub 2/DataHub/backend/src/services/manualGlMultiYearService.js';
let content = fs.readFileSync(filePath, 'utf8');

// Replace Summary return
const summaryOld = `  console.log(
    \`[ManualGL][PL][Debug] P&L result — years: \${JSON.stringify(summary.years)},\`,
    \`netProfitByYear: \${JSON.stringify(summary.netProfitByYear || {})}\`
  );

  return summary;
}`;

// I'll search for a more robust version since the one above might not match exactly due to character issues
const summaryRegex = /console\.log\(\s*`\[ManualGL\]\[PL\]\[Debug\] P&L result .*?netProfitByYear: \${JSON\.stringify\(summary\.netProfitByYear \|\| \{\}\)\}`\s*\);\s*return summary;\s*}/s;

content = content.replace(summaryRegex, (match) => {
    return `  const period = await getReportPeriodDates(companyId, effectiveBatchId);

  console.log(
    \`[ManualGL][PL][Debug] P&L result — years: \${JSON.stringify(summary.years)},\`,
    \`netProfitByYear: \${JSON.stringify(summary.netProfitByYear || {})}, period: \${JSON.stringify(period)}\`
  );

  return {
    ...summary,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}`;
});

// Replace Detail return
const detailOld = `  return buildProfitLossDetailPayload(normalized, {
    ...normalizedFilters,
    fiscalYears: selectedYears.length ? selectedYears : (normalizedFilters.fiscalYears || []),
  });
}`;

content = content.replace(detailOld, `  // Vendor-level aggregation
  const vendorPayload = buildVendorProfitLossDetailPayload(normalized, {
    ...normalizedFilters,
    fiscalYears: selectedYears.length ? selectedYears : (normalizedFilters.fiscalYears || []),
  });

  const period = await getReportPeriodDates(companyId, normalizedFilters.dataset_version_id || preBatchId);

  return {
    ...vendorPayload,
    startDate: period.startDate,
    endDate: period.endDate,
  };
}`);

fs.writeFileSync(filePath, content, 'utf8');
console.log('Successfully updated manualGlMultiYearService.js');
