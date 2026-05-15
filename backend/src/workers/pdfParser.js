/**
 * Worker thread for PDF text extraction.
 * Runs pdf-parse (pure-JS, CPU-heavy) off the main event loop so the server
 * stays responsive while parsing large documents.
 */
const { workerData, parentPort } = require("worker_threads");
const pdfParse = require("pdf-parse");

async function run() {
  try {
    const buffer = Buffer.from(workerData.arrayBuffer);
    const result = await pdfParse(buffer);
    parentPort.postMessage({ success: true, text: String(result?.text || "") });
  } catch (err) {
    parentPort.postMessage({ success: false, error: String(err?.message || "PDF parse error") });
  }
}

run();
