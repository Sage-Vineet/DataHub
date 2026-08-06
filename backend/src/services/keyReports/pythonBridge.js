'use strict';

/**
 * Node.js bridge to the Python extraction scripts in backend/python/.
 *
 * Python scripts communicate via:
 *   stdin  → raw file bytes
 *   stdout → JSON { rows, detected_years } or { error, rows, detected_years }
 *   stderr → debug logs (never treated as fatal)
 *
 * Primary entry points:
 *   extractWithPython(scriptName, fileBuffer, options) → { rows, detected_years }
 *   detectPdfType(fileBuffer)                          → 'text' | 'scanned' | 'mixed'
 *   checkPythonAvailability()                          → { available, pythonCmd, missing }
 */

const path = require('path');
const { spawn } = require('child_process');

const PYTHON_DIR = path.resolve(__dirname, '../../../python');
const TIMEOUT_MS = 120_000;  // 2 minutes
const REQUIRED_PKGS = ['openpyxl', 'pdfplumber', 'fitz'];  // quick presence check

// Cached result of Python binary detection (avoids repeated PATH scans per request)
let _pythonCmd = null;


// ── Python binary detection ───────────────────────────────────────────────────

/**
 * Return the Python 3 command name available on PATH, or null.
 * Tries 'python3' first, then 'python'. Result is cached after the first call.
 */
async function detectPython() {
  if (_pythonCmd !== null) return _pythonCmd;

  for (const cmd of ['python3', 'python']) {
    const found = await new Promise((resolve) => {
      const proc = spawn(cmd, ['--version'], { stdio: 'pipe', shell: false });
      proc.on('error', () => resolve(false));
      proc.stdout.on('data', (d) => {
        // stdout on Windows Python, stderr on some Python 2 builds
        if (/Python 3/i.test(d.toString())) resolve(true);
      });
      proc.stderr.on('data', (d) => {
        if (/Python 3/i.test(d.toString())) resolve(true);
      });
      proc.on('close', () => resolve(false));
    });
    if (found) {
      _pythonCmd = cmd;
      return cmd;
    }
  }

  _pythonCmd = false;  // sentinel: Python 3 not found
  return null;
}


// ── Serialize all Python subprocess invocations ─────────────────────────────
// CONFIRMED BUG this fixes: extraction is run with bounded concurrency at the
// JS level (keyReportSyncService's EXTRACTION_CONCURRENCY, default 4) — a
// version with 2+ linked Balance Sheet documents extracts them in parallel.
// Confirmed live across four unrelated companies (Davis Signs, Space X, Golf
// Sign Company, Seattle Painting Specialists): every single one had exactly
// 2 BS documents whose extraction completed within ~100ms of each other, and
// EVERY one of those pairs came back as a clean, well-formed result with ZERO
// rows carrying any hierarchy (parent_path) — while re-running the exact same
// file through this exact same code path alone (one at a time, this session's
// diagnostic scripts) succeeded correctly on the first try, every time, no
// exceptions. That pattern — fails only when 2+ run at once, never when run
// alone — points at a race in the Python interpreter's own startup (most
// likely first-time __pycache__ bytecode compilation for extract_excel.py /
// common.py racing across two simultaneously-spawned processes), not
// anything wrong with the extraction LOGIC itself, and not a caching bug —
// _isExtractionSuspicious already correctly detects and repairs a bad result
// after the fact, but the real fix is to stop the race from ever happening.
// A simple in-process queue removes the concurrency entirely: extraction is
// I/O-bound (subprocess spawn + file parse), not CPU-bound, so serializing it
// costs a few hundred ms per additional document, not seconds.
let _pythonSubprocessQueue = Promise.resolve();
function runExclusive(fn) {
  const result = _pythonSubprocessQueue.then(fn, fn);
  _pythonSubprocessQueue = result.then(() => {}, () => {});
  return result;
}

// ── Core subprocess helper ────────────────────────────────────────────────────

/**
 * Spawn a Python script, write fileBuffer to stdin, collect stdout JSON.
 * Serialized process-wide via runExclusive — see the comment above.
 *
 * @param {string}   scriptName  - Filename under backend/python/ (e.g. 'extract_excel.py')
 * @param {Buffer}   fileBuffer  - Raw file bytes sent to the script via stdin
 * @param {string[]} extraArgs   - Additional CLI args (e.g. ['--type', 'profit_loss'])
 * @returns {Promise<object>}    - Parsed JSON object from stdout
 */
async function runPythonScript(scriptName, fileBuffer, extraArgs = []) {
  return runExclusive(() => runPythonScriptInner(scriptName, fileBuffer, extraArgs));
}

async function runPythonScriptInner(scriptName, fileBuffer, extraArgs = []) {
  const pythonCmd = await detectPython();
  if (!pythonCmd) {
    throw new Error('Python 3 not found on PATH. Install Python 3 and run: pip install -r backend/python/requirements.txt');
  }

  const scriptPath = path.join(PYTHON_DIR, scriptName);
  const args = [scriptPath, ...extraArgs];

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonCmd, args, {
      cwd: PYTHON_DIR,   // ensures `from common import ...` resolves
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    // Enforce hard timeout
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(reject, new Error(`Python script ${scriptName} timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => { stdout += chunk; });

    // stderr → debug logs only — never fatal
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      chunk.toString().split('\n').filter(Boolean).forEach((line) => {
        if (process.env.NODE_ENV !== 'test') {
          console.debug(`[python/${scriptName}] ${line}`);
        }
      });
    });

    proc.on('error', (err) => {
      settle(reject, new Error(`Failed to spawn ${scriptName}: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;

      // Parse whatever stdout we got — Python may exit non-zero but still emit JSON
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        // stdout is not JSON — treat as fatal
        reject(new Error(
          `${scriptName} exited ${code} with non-JSON stdout.\n` +
          `stdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`
        ));
        return;
      }

      if (parsed.error) {
        reject(new Error(`${scriptName}: ${parsed.error}\nstderr: ${stderr.slice(0, 500)}`));
        return;
      }

      resolve(parsed);
    });

    // Suppress async EPIPE / EOF errors on stdin — if Python exits before we finish
    // writing, the writable stream emits 'error' asynchronously which would otherwise
    // become an uncaught exception that crashes the process.
    // The proc 'close' handler below is what surfaces the real error to callers.
    proc.stdin.on('error', (err) => {
      console.debug(`[python/${scriptName}] stdin write error (${err.code}) — Python exited early`);
    });

    // Write file bytes to stdin then close it — this triggers the Python script to start
    try {
      proc.stdin.write(fileBuffer, (err) => {
        if (err) {
          console.debug(`[python/${scriptName}] stdin write callback error: ${err.code}`);
          return;
        }
        proc.stdin.end();
      });
    } catch (e) {
      settle(reject, new Error(`Failed to write to ${scriptName} stdin: ${e.message}`));
    }
  });
}


// ── Binary-output subprocess helper ─────────────────────────────────────────
// Like runPythonScript, but the script emits RAW BYTES on stdout (not JSON) —
// used by decrypt_pdf.py, which returns a decrypted PDF. Resolves with
// { ok, code, stdout: Buffer } instead of throwing on non-zero exit, so the
// caller can distinguish "needs password" (code 3) from "no backend" (code 4).
async function runPythonBinary(scriptName, fileBuffer, extraArgs = []) {
  return runExclusive(() => runPythonBinaryInner(scriptName, fileBuffer, extraArgs));
}

async function runPythonBinaryInner(scriptName, fileBuffer, extraArgs = []) {
  const pythonCmd = await detectPython();
  if (!pythonCmd) return { ok: false, code: null, stdout: Buffer.alloc(0), reason: 'python-missing' };

  const scriptPath = path.join(PYTHON_DIR, scriptName);
  return new Promise((resolve) => {
    const proc = spawn(pythonCmd, [scriptPath, ...extraArgs], {
      cwd: PYTHON_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const chunks = [];
    let stderr = '';
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; clearTimeout(timer); resolve(val); } };

    const timer = setTimeout(() => { proc.kill('SIGKILL'); done({ ok: false, code: null, stdout: Buffer.alloc(0), reason: 'timeout' }); }, TIMEOUT_MS);

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      stderr += c;
      if (process.env.NODE_ENV !== 'test') {
        c.toString().split('\n').filter(Boolean).forEach((l) => console.debug(`[python/${scriptName}] ${l}`));
      }
    });
    proc.on('error', () => done({ ok: false, code: null, stdout: Buffer.alloc(0), reason: 'spawn-error' }));
    proc.on('close', (code) => {
      const stdout = Buffer.concat(chunks);
      done({ ok: code === 0 && stdout.length > 0, code, stdout, stderr });
    });

    proc.stdin.on('error', () => { /* Python exited early — surfaced via close */ });
    try {
      proc.stdin.write(fileBuffer, (err) => { if (!err) proc.stdin.end(); });
    } catch { done({ ok: false, code: null, stdout: Buffer.alloc(0), reason: 'stdin-error' }); }
  });
}

/**
 * Best-effort decrypt of an encrypted-but-not-password-locked PDF (empty user
 * password / owner-restricted). Returns the decrypted Buffer on success, or null
 * when the PDF needs a real password or no decrypt backend is available. Never
 * throws — the tax path degrades to a clear "password-protected" warning.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Buffer|null>}
 */
async function decryptPdfEmptyPassword(pdfBuffer) {
  try {
    const res = await runPythonBinary('decrypt_pdf.py', pdfBuffer, []);
    if (res.ok && res.stdout && res.stdout.length > 0) return res.stdout;
    return null;
  } catch {
    return null;
  }
}


// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract financial rows from a file using a Python script.
 *
 * @param {string} scriptName   - 'extract_excel.py' | 'extract_pdf_text.py' | 'extract_pdf_ocr.py'
 * @param {Buffer} fileBuffer   - Raw file bytes
 * @param {object} options
 * @param {string} options.type - 'profit_loss' | 'balance_sheet' | 'general_ledger' | 'bank_statement' | 'tax_return'
 * @param {string} [options.filename] - Original filename (for format hints)
 * @returns {Promise<{ rows: object[], detected_years: number[] }>}
 */
async function extractWithPython(scriptName, fileBuffer, options = {}) {
  const { type, filename = '' } = options;
  if (!type) throw new Error('extractWithPython: options.type is required');

  const extraArgs = ['--type', type];
  if (filename) extraArgs.push('--filename', filename);

  const result = await runPythonScript(scriptName, fileBuffer, extraArgs);

  // Normalise: always return rows + detected_years even if Python omitted them
  return {
    rows: Array.isArray(result.rows) ? result.rows : [],
    detected_years: Array.isArray(result.detected_years) ? result.detected_years : [],
  };
}


/**
 * Detect whether a PDF has a readable text layer or is image-only (scanned).
 *
 * @param {Buffer} fileBuffer - Raw PDF bytes
 * @returns {Promise<'text'|'scanned'|'mixed'>}
 */
async function detectPdfType(fileBuffer) {
  let result;
  try {
    result = await runPythonScript('detect_pdf_type.py', fileBuffer, []);
  } catch (err) {
    // If detection fails entirely, conservatively attempt text extraction
    console.warn('[pythonBridge.detectPdfType] detection failed, defaulting to text:', err.message);
    return 'text';
  }
  return result.pdf_type || 'text';
}


/**
 * Check whether Python 3 is available and required packages are installed.
 *
 * @returns {Promise<{ available: boolean, pythonCmd: string|null, missing: string[] }>}
 */
async function checkPythonAvailability() {
  const pythonCmd = await detectPython();
  if (!pythonCmd) {
    return { available: false, pythonCmd: null, missing: REQUIRED_PKGS };
  }

  // Quick import check for each required package
  const missing = [];
  for (const pkg of REQUIRED_PKGS) {
    const importName = pkg === 'fitz' ? 'fitz' : pkg.replace(/-/g, '_');
    const ok = await new Promise((resolve) => {
      const proc = spawn(
        pythonCmd,
        ['-c', `import ${importName}`],
        { stdio: 'ignore', shell: false }
      );
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
    if (!ok) missing.push(pkg);
  }

  return {
    available: missing.length === 0,
    pythonCmd,
    missing,
  };
}


module.exports = { extractWithPython, detectPdfType, checkPythonAvailability, decryptPdfEmptyPassword };
