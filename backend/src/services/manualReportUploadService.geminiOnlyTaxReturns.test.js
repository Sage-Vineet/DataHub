// Tax returns must be read DIRECTLY by Gemini, and by no other source.
//
// Run: node --test backend/src/services/manualReportUploadService.geminiOnlyTaxReturns.test.js
//
// WHY THIS MATTERS
// ──────────────────────────────────────────────────────────────────────────────
// A tax return is not a tabular statement. Its figures sit at named form lines
// (1120-S line 21, Schedule K line 16c, Schedule M-1 line 1), which is what
// TAX_EXTRACTION_PROMPT is built around. Every other reader in this codebase is a
// TABLE reader, so pointing one at a return does not degrade gracefully — it
// produces confidently wrong numbers that look completely normal downstream,
// because callers only ever check `parsed.report.rows.length`.
//
// CONFIRMED BUG these lock down: parseStoredReport() is called with
// forcedStatementType="tax_return" by the QMS upload sync (tax_return is in
// QMS_AI_STATEMENT_TYPES, so skipAI is false), and it then
//   1. sent the return to parsePdfWithGemini() — the GENERIC balance-sheet / P&L /
//      cash-flow prompt, which returns a {rows} tree and has no notion of a form
//      line. taxReturnExtractionService.js was already moved off that same call
//      for exactly this reason; this path had not been.
//   2. on ANY Gemini failure, or simply when GEMINI_API_KEY was unset, fell
//      through to the rule-based readers: extractPdfLines() (pdf-parse text) and
//      extractRowsFromWorkbook() (xlsx). detectStatementType() cannot return
//      "tax_return", so the output was filed under whatever else matched — and a
//      return containing "net income" matches the Profit & Loss test.
//
// These are source-level and pure-function assertions. They do not call Gemini.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const svc = require('./manualReportUploadService.js');
const {
  TAX_DOCUMENT_MIME_TYPES,
  resolveTaxDocumentMime,
  unreadableTaxDocumentReason,
  looksLikeTaxReturn,
} = svc;

const SERVICE_RAW = fs.readFileSync(path.join(__dirname, 'manualReportUploadService.js'), 'utf8');

/**
 * Comments removed. The comments that DOCUMENT these invariants necessarily name
 * the very readers a tax return must not reach ("sent the return to
 * parsePdfWithGemini() below"), so an ordering assertion run against the raw file
 * matches the documentation instead of the code and fails for the wrong reason.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const SERVICE_SRC = stripComments(SERVICE_RAW);

/** The body of a named function declaration, up to the next top-level `function`. */
function functionBody(src, name) {
  const start = src.indexOf(`async function ${name}(`) >= 0
    ? src.indexOf(`async function ${name}(`)
    : src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} must exist`);
  const next = src.indexOf('\nasync function ', start + 10);
  const next2 = src.indexOf('\nfunction ', start + 10);
  const end = Math.min(...[next, next2].filter((i) => i > -1));
  return src.slice(start, Number.isFinite(end) ? end : undefined);
}

describe('which files may be sent to Gemini', () => {
  test('PDF and the image formats Gemini accepts inline are readable', () => {
    // Scanned returns arrive as images at least as often as PDFs, so they must be
    // first-class rather than skipped.
    assert.equal(resolveTaxDocumentMime('2023 Return.pdf'), 'application/pdf');
    assert.equal(resolveTaxDocumentMime('scan.png'), 'image/png');
    assert.equal(resolveTaxDocumentMime('scan.PNG'), 'image/png', 'extension case must not matter');
    assert.equal(resolveTaxDocumentMime('scan.jpg'), 'image/jpeg');
    assert.equal(resolveTaxDocumentMime('scan.jpeg'), 'image/jpeg');
    assert.equal(resolveTaxDocumentMime('scan.webp'), 'image/webp');
    assert.equal(resolveTaxDocumentMime('scan.heic'), 'image/heic');
  });

  test('a format Gemini cannot read inline returns null — a hard stop', () => {
    for (const name of ['return.xlsx', 'return.xls', 'return.csv', 'return.docx', 'return.zip', 'return']) {
      assert.equal(resolveTaxDocumentMime(name), null, name);
    }
  });

  test('content type is honoured when the file name has no usable extension', () => {
    assert.equal(resolveTaxDocumentMime('scan', 'image/jpeg'), 'image/jpeg');
    assert.equal(resolveTaxDocumentMime('doc', 'application/pdf'), 'application/pdf');
  });

  test('a generic octet-stream content type falls back to the extension', () => {
    // Uploads frequently store application/octet-stream; the name is then the only
    // signal, and dropping the file for that reason would be wrong.
    assert.equal(resolveTaxDocumentMime('a.pdf', 'application/octet-stream'), 'application/pdf');
    assert.equal(resolveTaxDocumentMime('a.xlsx', 'application/octet-stream'), null);
  });

  test('the refusal names the file, the format, and what to do instead', () => {
    const reason = unreadableTaxDocumentReason('Return 2023.xlsx');
    assert.match(reason, /Return 2023\.xlsx/);
    assert.match(reason, /\.xlsx/);
    assert.match(reason, /read directly by Gemini/i);
    assert.match(reason, /was NOT read/);
    // It must list the formats that WOULD work, built from the same map.
    for (const ext of Object.keys(TAX_DOCUMENT_MIME_TYPES)) {
      assert.ok(reason.includes(`.${ext}`), `must offer .${ext}`);
    }
  });
});

describe('a tax return can never reach a non-Gemini reader', () => {
  const body = functionBody(SERVICE_SRC, 'parseStoredReport');

  /**
   * The tax-return branch only. Bounded by a CODE anchor — the generic Gemini
   * branch that follows it — rather than by a comment: comments are stripped
   * above, so a comment anchor would not be found and `slice` would silently run
   * to the end of the function, sweeping in the very readers under test.
   */
  const taxBranch = () => {
    const start = body.indexOf('if (resolvedTaxType) {');
    const end = body.indexOf('if (isPdf && process.env.GEMINI_API_KEY && !skipAI)');
    assert.ok(start > -1, 'the tax-return branch must exist');
    assert.ok(end > start, 'the generic Gemini branch must follow the tax branch');
    return body.slice(start, end);
  };

  test('parseStoredReport routes tax returns out before any other reader', () => {
    const taxGuard = body.indexOf('resolvedTaxType');
    const genericGemini = body.indexOf('parsePdfWithGemini');
    const pdfText = body.indexOf('extractPdfLines');
    const workbook = body.indexOf('extractRowsFromWorkbook');

    assert.ok(taxGuard > -1, 'the tax-return branch must exist');
    assert.ok(genericGemini > taxGuard,
      'the generic financial-statement Gemini prompt must come AFTER the tax branch');
    assert.ok(pdfText > taxGuard, 'the pdf-parse text fallback must come after the tax branch');
    assert.ok(workbook > taxGuard, 'the xlsx fallback must come after the tax branch');
  });

  test('the tax branch always returns or throws — it never falls through', () => {
    const branch = taxBranch();
    assert.ok(/return \{/.test(branch), 'the branch must return on success');
    assert.equal((branch.match(/throw new Error/g) || []).length, 3,
      'unreadable format, empty file, and undetermined year must each throw');
    // No break/fallthrough that would continue into the generic readers.
    assert.ok(!/\bbreak\b/.test(branch));
  });

  test('the tax branch uses the dedicated tax extractor, not the statement prompt', () => {
    const branch = taxBranch();
    assert.ok(/extractTaxDataWithVerification\(/.test(branch),
      'must use the purpose-built tax reader');
    assert.ok(!/parsePdfWithGemini/.test(branch),
      'must NOT use the generic balance-sheet/P&L prompt');
    assert.ok(/parserType: "gemini-tax-direct"/.test(branch),
      'the parser must be identifiable as the direct tax reader in stored data');
  });

  test('a missing GEMINI_API_KEY is a hard failure for tax returns, not a fallback', () => {
    assert.ok(/function assertGeminiConfiguredForTaxReturns\(\)/.test(SERVICE_SRC));
    // Both entry points must assert it.
    const fromBuffer = functionBody(SERVICE_SRC, 'extractTaxDataFromBuffer');
    const withVerification = functionBody(SERVICE_SRC, 'extractTaxDataWithVerification');
    assert.ok(/assertGeminiConfiguredForTaxReturns\(\)/.test(fromBuffer));
    assert.ok(/assertGeminiConfiguredForTaxReturns\(\)/.test(withVerification));
    // And the guard must say there is no fallback, so the cause is obvious.
    assert.match(SERVICE_SRC, /there is no\s*\n?\s*"?\s*\+?\s*"?fallback reader for them/);
  });

  test('the mime type is threaded to every Gemini call, never hardcoded to PDF', () => {
    // An image return sent as application/pdf is rejected by the API, which the old
    // hardcoded mime type made unavoidable.
    for (const fn of ['extractTaxDataFromBuffer', 'extractTaxDataWithVerification', 'verifyScheduleKItems']) {
      const b = functionBody(SERVICE_SRC, fn);
      assert.ok(/inlineData: \{ mimeType, data/.test(b),
        `${fn} must pass the resolved mimeType through`);
      assert.ok(!/mimeType: "application\/pdf"/.test(b),
        `${fn} must not hardcode application/pdf`);
    }
  });
});

describe('a return that was never declared as one is refused, not misfiled', () => {
  test('IRS form designations are recognised', () => {
    const cases = [
      ['Form 1120-S U.S. Income Tax Return for an S Corporation'],
      ['Form 1065 U.S. Return of Partnership Income'],
      ['Form 1120  U.S. Corporation Income Tax Return'],
      ['Schedule K-1 (Form 1065)'],
      ["Shareholders' Pro Rata Share Items"],
      ["Partners' Distributive Share Items"],
      ['Department of the Treasury  Internal Revenue Service'],
    ];
    for (const [line] of cases) {
      assert.equal(looksLikeTaxReturn({ lines: [line] }), true, line);
    }
  });

  test('it matches on the file name too', () => {
    assert.equal(looksLikeTaxReturn({ fileName: '2023 Form 1120-S Accepted.pdf' }), true);
  });

  test('a real financial statement is NOT flagged', () => {
    // A false positive here would reject legitimate statements, so the markers are
    // deliberately narrow: soft signals shared with management reports must not match.
    const statements = [
      { fileName: 'Profit and Loss 2024.xlsx', rows: [['Net Income', '123']] },
      { fileName: 'Balance Sheet Dec 2024.xlsx', rows: [['Total Assets', '1'], ['Total Liabilities', '2']] },
      { fileName: 'Cash Flow 2024.pdf', lines: ['Operating activities', 'Depreciation 5,000'] },
      { fileName: 'General Ledger 2023.csv', lines: ['Income tax expense', '2023'] },
      { fileName: 'Tax provision schedule.xlsx', lines: ['Income tax', 'Deferred tax'] },
    ];
    for (const s of statements) {
      assert.equal(looksLikeTaxReturn(s), false, s.fileName);
    }
  });

  test('parseStoredReport refuses such a file rather than filing it as a P&L', () => {
    const body = functionBody(SERVICE_SRC, 'parseStoredReport');
    const guard = body.indexOf('looksLikeTaxReturn(');
    const detect = body.indexOf('detectStatementType({');
    assert.ok(guard > -1 && detect > -1);
    assert.ok(guard < detect,
      'the refusal must happen BEFORE the rule-based statement-type guess');
    assert.match(body.slice(guard, detect), /throw new Error/);
  });
});

describe('a file that is not read is reported, never silently dropped', () => {
  test('the folder sync records a failure for every unreadable document', () => {
    const body = functionBody(SERVICE_SRC, 'syncTaxReturnFolder');
    // The two former silent `continue`s must now push a reason first.
    assert.ok(/has no readable file contents/.test(body),
      'a document with no binary must be reported');
    assert.ok(/unreadableTaxDocumentReason\(fileName\)/.test(body),
      'a non-Gemini-readable format must be reported');
    // Nothing may skip without recording why.
    const skips = body.match(/continue;/g) || [];
    const pushes = body.match(/failedDocs\.push\(/g) || [];
    assert.ok(pushes.length >= skips.length - 1,
      `every skip should record a reason (skips=${skips.length}, reported=${pushes.length})`);
  });

  test('the folder sync sends the resolved mime type to Gemini', () => {
    const body = functionBody(SERVICE_SRC, 'syncTaxReturnFolder');
    assert.ok(/resolveTaxDocumentMime\(/.test(body));
    assert.ok(/extractTaxDataFromBuffer\(buffer, cacheKey, \{ mimeType \}\)/.test(body));
  });

  test('the Tax Reconciliation route reports unreadable documents as warnings', () => {
    const routeSrc = stripComments(fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'manualReportUploads.js'), 'utf8',
    ));
    assert.ok(/unreadable: true/.test(routeSrc),
      'the route must mark a document it could not send to Gemini');
    assert.ok(/if \(s\.status === "fulfilled" && s\.value\?\.unreadable\)/.test(routeSrc),
      'and must fold that into the response warnings');
    assert.ok(/warnings\.push\(s\.value\.reason\)/.test(routeSrc));
    assert.ok(/resolveTaxDocumentMime\(/.test(routeSrc),
      'the route must decide readability from the shared helper');
    assert.ok(/extractTaxDataWithVerification\(buffer, cacheKey, \{ mimeType \}\)/.test(routeSrc));
    // The encryption probe only applies to PDFs now that images are accepted.
    assert.ok(/mimeType === "application\/pdf" && isEncryptedPdf\(buffer\)/.test(routeSrc));
  });
});

describe('no other extractor claims tax returns', () => {
  test('Key Reports tax extraction is Gemini-direct', () => {
    const src = stripComments(fs.readFileSync(path.join(__dirname, 'keyReports', 'taxReturnExtractionService.js'), 'utf8'));
    assert.ok(/_extractWithGemini/.test(src));
    assert.ok(/parseTaxReturnWithGemini/.test(src));
    assert.ok(!/extractWithPython/.test(src),
      'the Python text/OCR path must not be used for tax returns');
  });

  test('nothing in the JS asks Python for a tax return', () => {
    // extract_pdf_text.py / extract_pdf_ocr.py still carry a `--type tax_return`
    // branch; no caller may reintroduce it.
    const dir = path.join(__dirname, 'keyReports');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const src = stripComments(fs.readFileSync(path.join(dir, file), 'utf8'));
      const calls = src.match(/extractWithPython\([^)]*\{[^}]*type:\s*'([a-z_]+)'/g) || [];
      for (const call of calls) {
        assert.ok(!/tax_return/.test(call), `${file} must not send tax returns to Python`);
      }
    }
  });
});
