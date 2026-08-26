#!/usr/bin/env node
/**
 * Turn the CIM question library that already exists into seed rows.
 *
 * `WorkspaceCimPrep.jsx` carries two bodies of authored question text that
 * nobody has treated as a library:
 *
 *   - `FIELD_LABEL_OVERRIDES`, several hundred entries whose `label` is usually
 *     already a question ("What is the company's gross margin (%)?") and which
 *     is already bound to a slide, order and token index — that is, already bound
 *     to a block.
 *   - `SECTION_QUESTION_BANK`, section-level prompts written for the seller.
 *
 * `CM - 0004` asks for "a question library mapped to the content block it fills",
 * which is most of the way built. This reads both out and emits SQL, so the demo
 * asks questions an accountant actually wrote rather than ones invented for a
 * fixture.
 *
 * Run once at authoring time — NOT a build step:
 *   node tools/demo/extract-cim-questions.mjs > tools/demo/seed-cim-questions.sql
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(ROOT, "apps/web/src/pages/broker/workspace/WorkspaceCimPrep.jsx");
const src = readFileSync(SOURCE, "utf8");

/** Pull a top-level `const NAME = <literal>;` block out by brace matching. */
function extractLiteral(name, open, close) {
  const start = src.indexOf(`const ${name} = ${open}`);
  if (start === -1) throw new Error(`${name} not found in ${SOURCE}`);
  let depth = 0;
  let i = src.indexOf(open, start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

/**
 * Pull a top-level `function NAME(...) { ... }` out, by brace matching.
 *
 * `FIELD_LABEL_OVERRIDES` is not a pure literal — it spreads several helpers that
 * generate the per-period metric questions. Evaluating the array therefore needs
 * those helpers in scope, and lifting them verbatim is more faithful than
 * reimplementing what they do.
 */
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${SOURCE}`);

  // Walk the parameter list first. A default value like `extra = {}` puts braces
  // ahead of the body, so scanning for the first `{` cuts the function in half.
  let i = src.indexOf("(", start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") {
      parens--;
      if (parens === 0) break;
    }
  }

  let depth = 0;
  for (i = src.indexOf("{", i); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

/** Period vocabularies the generators default to. */
const PRELUDE = [
  "const SLIDE_24_HISTORICAL_PERIODS = [\"FY[Y-3]\", \"FY[Y-2]\", \"FY[Y-1]\", \"FY[Y]\"];",
  "const SLIDE_24_ALL_PERIODS = [...SLIDE_24_HISTORICAL_PERIODS, \"LTM\"];",
  "const THREE_YEAR_LTM_PERIODS = [\"FY[Y-2]\", \"FY[Y-1]\", \"FY[Y]\", \"LTM\"];",
  "const TWO_YEAR_LTM_PERIODS = [\"FY[Y-1]\", \"FY[Y]\", \"LTM\"];",
  "const FY_LTM_PERIODS = [\"FY[Y]\", \"LTM\"];",
  "const PROJECTION_PERIODS = [\"FY[Y]A (Base)\", \"FY[Y+1]E\", \"FY[Y+2]E\", \"FY[Y+3]E\", \"FY[Y+4]E\"];",
  "const FORWARD_PROJECTION_PERIODS = [\"FY[Y+1]E\", \"FY[Y+2]E\", \"FY[Y+3]E\", \"FY[Y+4]E\"];",
  extractFunction("makeLabelOverride"),
  extractFunction("makeSlide24MetricRowOverrides"),
  extractFunction("makePeriodMetricOverrides"),
].join("\n");

// The literals are plain data once their generators are in scope, so evaluating
// them is the honest way to read them — a regex would silently miss any entry
// spanning several lines, and many do.
const labelOverrides = new Function(
  `${PRELUDE}\nreturn ${extractLiteral("FIELD_LABEL_OVERRIDES", "[", "]")}`,
)();
const questionBank = new Function(`return ${extractLiteral("SECTION_QUESTION_BANK", "{", "}")}`)();
const sectionSlides = new Function(`return ${extractLiteral("SECTION_SLIDES", "[", "]")}`)();

/** Which section a slide number belongs to. */
const sectionForSlide = new Map();
for (const section of sectionSlides) {
  for (const slide of section.slides) sectionForSlide.set(slide, section.id);
}

const esc = (s) => String(s).replace(/'/g, "''");

/**
 * Only labels that read as questions become library entries.
 *
 * A label like "Key Investment Themes" is a field name, not something to ask a
 * seller — sending it verbatim would produce a request that reads like a form.
 */
const isQuestion = (label) => typeof label === "string" && label.trim().endsWith("?");

const rows = [];
let order = 0;

for (const entry of labelOverrides) {
  if (!isQuestion(entry.label)) continue;
  const sectionKey = sectionForSlide.get(entry.slide) ?? "unclassified";
  // The block key convention the SPA already uses, so a library question and an
  // imported block agree on what they are talking about.
  const blockKey = `${entry.slide}:${entry.order}:token:${entry.tokenIndex}`;
  rows.push({
    scope: "system",
    sectionKey,
    layoutKey: `source-slide-${String(entry.slide).padStart(2, "0")}`,
    blockKeyPattern: blockKey,
    questionText: entry.label,
    helpText: Array.isArray(entry.options) ? `Options: ${entry.options.join("; ")}` : null,
    sortOrder: (order += 1),
  });
}

for (const [sectionKey, entries] of Object.entries(questionBank)) {
  for (const [key, text] of entries) {
    rows.push({
      scope: "system",
      sectionKey,
      layoutKey: null,
      // Section-level prompts fill no single block; they are the fallback the
      // broker picks from when a gap has no bound question.
      blockKeyPattern: null,
      questionText: text,
      helpText: `Section prompt (${key})`,
      sortOrder: (order += 1),
    });
  }
}

const lines = [
  "-- CIM question library — GENERATED, do not edit by hand.",
  "--",
  "-- Source: FIELD_LABEL_OVERRIDES and SECTION_QUESTION_BANK in",
  "-- apps/web/src/pages/broker/workspace/WorkspaceCimPrep.jsx, which already held",
  "-- several hundred authored questions bound to the blocks they fill.",
  "--",
  "-- Regenerate: node tools/demo/extract-cim-questions.mjs > tools/demo/seed-cim-questions.sql",
  "",
  "BEGIN;",
  "",
  "DELETE FROM cim_question_library WHERE scope = 'system';",
  "",
  "INSERT INTO cim_question_library (scope, section_key, layout_key, block_key_pattern, question_text, help_text, sort_order) VALUES",
];

const values = rows.map(
  (r) =>
    `  ('${r.scope}', '${esc(r.sectionKey)}', ` +
    `${r.layoutKey ? `'${esc(r.layoutKey)}'` : "NULL"}, ` +
    `${r.blockKeyPattern ? `'${esc(r.blockKeyPattern)}'` : "NULL"}, ` +
    `'${esc(r.questionText)}', ` +
    `${r.helpText ? `'${esc(r.helpText)}'` : "NULL"}, ${r.sortOrder})`,
);

lines.push(values.join(",\n") + ";", "", "COMMIT;", "");
process.stdout.write(lines.join("\n"));
process.stderr.write(
  `extracted ${rows.length} questions (${labelOverrides.length} labels scanned, ` +
    `${rows.filter((r) => r.blockKeyPattern).length} bound to a block)\n`,
);
