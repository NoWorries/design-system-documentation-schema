#!/usr/bin/env node
/**
 * Writes AGENTS.md's two field-list blocks from the schema files that own them.
 *
 * AGENTS.md is the first file an agent reads, and it teaches two lists: the fields every entry
 * shares (entries/entry.schema.yaml) and the fields every section shares
 * (sections/section.schema.yaml). Both were typed by hand. The entry one had drifted - `id`
 * before `kind`, and `sections` moved to the end - while the paragraph beside it said the
 * tooling reads the order out of the schema so it can't be wrong. It couldn't be wrong; the
 * list next to it could, and was.
 *
 * These are the same lists `declaredProps` hands to dsds-format (scripts/format/format.js), and
 * the same ones the Schema page's property tables are built from. Now they're also the ones
 * AGENTS.md prints, so an agent that learns the envelope here writes the order dsds-format applies.
 *
 * Usage:
 *   node scripts/generate/sync-envelopes.mjs           # rewrite the blocks
 *   node scripts/generate/sync-envelopes.mjs --check   # exit 1 if either has drifted
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { syncRegion } from "./regions.mjs";

const require = createRequire(import.meta.url);
const { declaredProps } = require("../lib.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const AGENTS = path.join(ROOT, "AGENTS.md");

// A fenced block with no language, matching how AGENTS.md already showed these: a bare list of
// field names, not a code sample anything would run.
const fence = (fields) => ["```", fields.join(", "), "```"].join("\n");

const ENVELOPES = [
  {
    region: "entry-envelope",
    schema: "entries/entry.schema.yaml",
    label: "AGENTS.md's entry envelope",
  },
  {
    region: "section-envelope",
    schema: "sections/section.schema.yaml",
    label: "AGENTS.md's section envelope",
  },
];

const check = process.argv.includes("--check");
let allCurrent = true;

for (const { region, schema, label } of ENVELOPES) {
  const current = syncRegion({
    file: AGENTS,
    name: region,
    // declaredProps throws if the file stops declaring properties of its own, which is the
    // right outcome: a restructured schema should fail the build, not publish an empty list.
    render: () => fence(declaredProps(schema)),
    check,
    label: `${label} (from schema/${schema})`,
  });
  allCurrent = allCurrent && current;
}

if (check && allCurrent) {
  console.log("✓ Both AGENTS.md envelopes match the schema files they're derived from.");
}
