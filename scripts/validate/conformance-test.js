#!/usr/bin/env node
// Layer 3 of the conformance model (see overview.mdx's Conformance section): a fixture per
// semantic rule id (examples/invalid/DSDS-XX-*.yaml), each carrying a leading `# expect:
// DSDS-XXX` comment, run through the exact same validateDoc() the CLI uses - not a second
// copy of the validation logic. This lets an independent validator (or CI) check "do I
// enforce the same rules," not just "does mine pass on valid documents."
//
// The fixture contract (rejectedBy + errorAt): a fixture declares not just a rule id but *how*
// it must fail - `# rejectedBy: schema` (a pure JSON Schema violation) or `# rejectedBy:
// semantic` (a hand-written DSDS-01-10 check), plus an optional `# errorAt: /json/pointer`
// asserting *where*. Checking the rule id alone can't catch a fixture that starts failing for
// the wrong reason - a schema change that accidentally makes an unrelated field reject the
// same document would still pass a rule-id-only check.
"use strict";

const fs = require("fs");
const path = require("path");
const { rootDir, loadYaml, entryFieldOrder } = require("../lib");
const { validateDoc, RULES } = require("./validate");

const FIXTURES_DIR = path.join(rootDir, "examples/invalid");

function leadingComment(raw, key) {
  const match = raw.match(new RegExp(`^#\\s*${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function expectedIds(raw) {
  const value = leadingComment(raw, "expect");
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function idsIn(errors) {
  const ids = new Set();
  for (const e of errors) {
    const m = e.match(/^\[(DSDS-\d+)\]/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// Pure JSON Schema (ajv) failures are never tagged with a [DSDS-XX] id - they're the errors
// left over once every DSDS-tagged one is set aside.
function schemaErrors(errors) {
  return errors.filter((e) => !/^\[DSDS-\d+\]/.test(e));
}

// Every schema-level error string follows "... schema: <instancePath> <message>" - extract
// the instancePath back out rather than threading a structured error object through validateDoc
// just for this. A fixture's `# errorAt:` comment should write the root pointer as "/", not "".
function instancePathsIn(errors) {
  const paths = [];
  for (const e of errors) {
    const m = e.match(/schema:\s+(\S+)\s/);
    if (m) paths.push(m[1]);
  }
  return paths;
}

const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".yaml")).sort();

let ok = true;

for (const file of files) {
  const filePath = path.join(FIXTURES_DIR, file);
  const raw = fs.readFileSync(filePath, "utf8");
  const expected = expectedIds(raw);
  const rejectedBy = leadingComment(raw, "rejectedBy");
  const errorAt = leadingComment(raw, "errorAt");

  if (!rejectedBy || (rejectedBy !== "schema" && rejectedBy !== "semantic")) {
    console.error(`✗ ${file}: no "# rejectedBy: schema|semantic" comment - every fixture must declare which layer is supposed to reject it`);
    ok = false;
    continue;
  }
  if (rejectedBy === "semantic" && expected.length === 0) {
    console.error(`✗ ${file}: "# rejectedBy: semantic" but no "# expect: DSDS-XXX" comment`);
    ok = false;
    continue;
  }

  const doc = loadYaml(filePath);
  const { errors, warnings, findings } = validateDoc(doc, { filePath });
  const allFindings = [...errors, ...warnings];

  // A check on the reference validator, not on the fixture: when one part of an entry fails,
  // Ajv can also report the entry's allowed fields as "unevaluated". validate.js drops those
  // (isFalseUnevaluated), since they send a reader to fix the wrong field. Six fixtures here
  // used to produce them.
  const bogus = (findings || []).filter((f) => {
    if (!/must NOT have unevaluated properties/.test(f.message)) return false;
    const field = (f.pointer || "").split("/")[1];
    return field !== undefined && f.pointer.split("/").length === 2 && entryFieldOrder(doc.kind).includes(field);
  });
  if (bogus.length) {
    console.error(`✗ ${file}: reported declared field(s) as unevaluated: ${bogus.map((f) => f.pointer).join(", ")}`);
    ok = false;
    continue;
  }

  if (rejectedBy === "semantic") {
    // A rule can legitimately fire as either - a project-scope finding is a warning until
    // --strict, not an error - so both channels need checking, not just errors.
    const fired = idsIn(allFindings);
    const missing = expected.filter((id) => !fired.has(id));
    if (missing.length) {
      console.error(`✗ ${file}: expected [${expected.join(", ")}] but got [${[...fired].join(", ") || "no rule ids at all"}]`);
      ok = false;
      continue;
    }
  } else {
    // rejectedBy: schema - must fail with at least one un-tagged (pure ajv) error. A fixture
    // that instead only trips a hand-written DSDS-XX rule isn't testing what it claims to.
    const schemaFindings = schemaErrors(allFindings);
    if (schemaFindings.length === 0) {
      console.error(`✗ ${file}: "rejectedBy: schema" but every finding was DSDS-tagged (or the document validated clean) - [${allFindings.join("; ") || "none"}]`);
      ok = false;
      continue;
    }
    if (errorAt !== null) {
      const paths = instancePathsIn(schemaFindings);
      if (!paths.includes(errorAt)) {
        console.error(`✗ ${file}: expected a schema error at "${errorAt}" but got [${paths.map((p) => p || "/").join(", ")}]`);
        ok = false;
        continue;
      }
    }
  }

  console.log(`✓ ${file} -> ${rejectedBy}${expected.length ? `: ${expected.join(", ")}` : ""}${errorAt !== null ? ` @ ${errorAt || "/"}` : ""}`);
}

// Every semantic rule id the validator knows about should have at least one fixture. This
// check only applies to DSDS-XX ids - schema-level coverage has no finite catalog to check
// against.
const allIds = new Set(Object.values(RULES));
const coveredIds = new Set(files.flatMap((f) => expectedIds(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8"))));
const uncovered = [...allIds].filter((id) => !coveredIds.has(id));
if (uncovered.length) {
  console.error(`✗ no fixture covers: ${uncovered.join(", ")}`);
  ok = false;
}

process.exit(ok ? 0 : 1);
