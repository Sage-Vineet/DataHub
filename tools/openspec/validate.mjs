#!/usr/bin/env node
/**
 * OpenSpec structural validator.
 *
 * There is no `openspec` binary pinned in this repo, so nothing checked spec
 * structure and nothing noticed a completed change sitting unarchived. In Aug 2026
 * that stranded 44 requirements of shipped behaviour inside change folders while the
 * baseline still described three capabilities. This script is the check that would
 * have caught it.
 *
 * Run: `just spec-validate` (or `node tools/openspec/validate.mjs`)
 * Exits non-zero on any error. Warnings do not fail the build.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SPECS = join(ROOT, "openspec/specs");
const CHANGES = join(ROOT, "openspec/changes");
const PRODUCT = join(ROOT, "openspec/product");

const OP_HEADER = /^## (ADDED|MODIFIED|REMOVED|RENAMED) Requirements\s*$/m;
const OP_HEADER_ANY = /^## (ADDED|MODIFIED|REMOVED|RENAMED)/m;

const errors = [];
const warnings = [];
const err = (f, m) => errors.push(`${relative(ROOT, f)}: ${m}`);
const warn = (f, m) => warnings.push(`${relative(ROOT, f)}: ${m}`);

/** Recursively collect files named `spec.md`, skipping `archive/`. */
function findSpecs(dir, { includeArchive = false } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (!includeArchive && entry === "archive") continue;
      out.push(...findSpecs(p, { includeArchive }));
    } else if (entry === "spec.md") {
      out.push(p);
    }
  }
  return out;
}

/** Every `### Requirement:` must own at least one `#### Scenario:`. */
function checkScenarios(file, src, report) {
  const lines = src.split("\n");
  let current = null;
  let count = 0;
  for (const line of lines) {
    if (line.startsWith("### Requirement:")) {
      if (current && count === 0) report(file, `requirement has no scenario — "${current}"`);
      current = line.replace("### Requirement:", "").trim();
      count = 0;
    } else if (line.startsWith("#### Scenario:") && current) {
      count++;
    }
  }
  if (current && count === 0) report(file, `requirement has no scenario — "${current}"`);
}

// ---------------------------------------------------------------- baseline
const baseline = findSpecs(SPECS);
for (const file of baseline) {
  const src = readFileSync(file, "utf8");
  const first = src.split("\n", 1)[0];

  if (!/^# \S.* Specification\s*$/.test(first))
    err(file, `first line must be "# <capability> Specification", got "${first}"`);
  if (!/^## Purpose\s*$/m.test(src)) err(file, "missing `## Purpose`");

  const reqHeaders = (src.match(/^## Requirements\s*$/gm) || []).length;
  if (reqHeaders !== 1) err(file, `expected exactly one \`## Requirements\`, found ${reqHeaders}`);

  if (OP_HEADER_ANY.test(src))
    err(file, "operation header (ADDED/MODIFIED/…) leaked into the baseline — strip it on sync");

  if (!/^### Requirement:/m.test(src)) err(file, "no requirements");
  checkScenarios(file, src, err);
}

// ------------------------------------------------------------------ deltas
const activeChanges = existsSync(CHANGES)
  ? readdirSync(CHANGES).filter((d) => d !== "archive" && statSync(join(CHANGES, d)).isDirectory())
  : [];

for (const change of activeChanges) {
  const dir = join(CHANGES, change);

  for (const file of findSpecs(join(dir, "specs"))) {
    const src = readFileSync(file, "utf8");
    if (!/^## Purpose\s*$/m.test(src)) err(file, "missing `## Purpose`");
    if (!OP_HEADER.test(src))
      err(file, "delta spec needs an ADDED/MODIFIED/REMOVED/RENAMED Requirements header");
    if (/^## Requirements\s*$/m.test(src))
      err(file, "delta spec must not use a bare `## Requirements` — that is baseline-only");
    checkScenarios(file, src, err);
  }

  // The rule that would have caught the Aug 2026 backlog.
  const tasks = join(dir, "tasks.md");
  if (existsSync(tasks)) {
    const t = readFileSync(tasks, "utf8");
    const done = (t.match(/^\s*- \[x\]/gim) || []).length;
    const open = (t.match(/^\s*- \[ \]/gm) || []).length;
    if (done > 0 && open === 0)
      err(
        tasks,
        `change "${change}" is at 100% (${done}/${done} tasks) but is not archived — sync it and move it to changes/archive/`,
      );
  } else {
    warn(join(dir, "tasks.md"), `change "${change}" has no tasks.md`);
  }
}

// -------------------------------------------------- product surface register
if (existsSync(PRODUCT)) {
  if (!existsSync(join(PRODUCT, "README.md")))
    err(PRODUCT, "product register must carry a README.md explaining why it is not a change");

  // The register must stay outside the change lifecycle: nothing may sync it.
  const stray = findSpecs(join(CHANGES, "centuriuum-product-surface", "specs"));
  if (stray.length)
    err(
      join(CHANGES, "centuriuum-product-surface"),
      `product surface specs are back under changes/ (${stray.length} files) — archiving would sync them into the baseline`,
    );
}

// ------------------------------------------------------------------ report
const capCount = baseline.length;
const reqCount = baseline.reduce(
  (n, f) => n + (readFileSync(f, "utf8").match(/^### Requirement:/gm) || []).length,
  0,
);
const scenCount = baseline.reduce(
  (n, f) => n + (readFileSync(f, "utf8").match(/^#### Scenario:/gm) || []).length,
  0,
);

console.log(
  `openspec: baseline ${capCount} capabilities, ${reqCount} requirements, ${scenCount} scenarios · ${activeChanges.length} active changes`,
);

for (const w of warnings) console.log(`  warn  ${w}`);
for (const e of errors) console.error(`  ERROR ${e}`);

if (errors.length) {
  console.error(`\nopenspec: ${errors.length} error(s)`);
  process.exit(1);
}
console.log("openspec: ok");
