#!/usr/bin/env node
/**
 * Every requirement in the normative prose has to say what enforces it.
 *
 * Reads the Specification and the Processing model pages. From section 2 on, every sentence
 * with a MUST or MUST NOT must carry a citation in parentheses, made of one or more of:
 *
 *   schema: <path>[, <path>]   a schema file, as schema/<path>.schema.yaml
 *   DSDS-NN                    a rule in schema/conformance-rules.yaml, not retired
 *   vector: <name>             a consumer test vector, as examples/vectors/<name>/
 *   suite                      the conformance suite
 *   consumer                   a requirement on consumers no document check can see
 *
 * joined with `;` or `,`. It fails when a requirement has no citation, when a citation names
 * something that doesn't exist, or when a semantic rule in the catalog isn't cited anywhere -
 * a rule the spec never mentions is a rule nobody can find the reason for.
 *
 * Usage: node scripts/checks/check-normative-citations.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGES = ["site/content/specification.mdx", "site/content/processing.mdx"];
const catalog = yaml.load(fs.readFileSync(path.join(ROOT, "schema/conformance-rules.yaml"), "utf-8"));
const liveRules = new Set(catalog.filter((r) => !r.retired && r.enforcement !== "none").map((r) => r.id));
const semanticRules = catalog.filter((r) => r.enforcement === "semantic" && !r.retired).map((r) => r.id);

const problems = [];
const cited = new Set();
let requirements = 0;
const byKind = { schema: 0, rule: 0, vector: 0, suite: 0, consumer: 0 };

// One citation group, like "schema: entries/entry, common/id; DSDS-04". Returns the problems
// with it, or null when the parenthetical isn't a citation at all.
function checkCitation(text, where) {
  const body = text.replace(/`/g, "").trim();
  const parts = body.split(/\s*;\s*/);
  const out = [];
  let looksLikeCitation = false;
  for (const part of parts) {
    let m;
    if ((m = /^schema:\s*(.+)$/.exec(part))) {
      looksLikeCitation = true;
      byKind.schema++;
      for (const file of m[1].split(/\s*,\s*/)) {
        if (!fs.existsSync(path.join(ROOT, "schema", `${file}.schema.yaml`))) out.push(`${where}: cites schema "${file}", but schema/${file}.schema.yaml doesn't exist`);
      }
    } else if ((m = /^vector:\s*(.+)$/.exec(part))) {
      looksLikeCitation = true;
      byKind.vector++;
      for (const name of m[1].split(/\s*,\s*/)) {
        if (!fs.existsSync(path.join(ROOT, "examples/vectors", name, "expected.json"))) out.push(`${where}: cites vector "${name}", but examples/vectors/${name}/expected.json doesn't exist`);
      }
    } else if (/^(suite|consumer)$/.test(part)) {
      looksLikeCitation = true;
      byKind[part]++;
    } else if (/^DSDS-\d+(\s*,\s*DSDS-\d+)*$/.test(part)) {
      looksLikeCitation = true;
      byKind.rule++;
      for (const id of part.split(/\s*,\s*/)) {
        cited.add(id);
        if (!liveRules.has(id)) out.push(`${where}: cites ${id}, which isn't a live rule in schema/conformance-rules.yaml`);
      }
    } else {
      return null;
    }
  }
  return looksLikeCitation ? out : null;
}

for (const page of PAGES) {
  const text = fs.readFileSync(path.join(ROOT, page), "utf-8");
  // Section 1 of each page is conventions and terms: it talks about the words, not with them.
  const start = text.search(/^## 2\./m);
  if (start === -1) {
    problems.push(`${page}: no "## 2." heading - the check needs numbered sections`);
    continue;
  }
  const body = text.slice(start).replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
  const lineAt = (offset) => text.slice(0, start + offset).split("\n").length;

  // Units: list items, table rows and paragraphs, each split into sentences.
  let offset = 0;
  for (const block of body.split(/\n(?=\s*\n)|\n(?=\s*[-*] |\s*\d+\. |\|)/)) {
    const blockStart = body.indexOf(block, offset);
    offset = blockStart + block.length;
    const flat = block.replace(/\s+/g, " ");
    const sentences = block.startsWith("|") || block.trimStart().startsWith("|") ? [flat] : flat.split(/(?<=[.!?])\s+(?=[A-Z`*\[(])/);
    for (const sentence of sentences) {
      if (!/\bMUST\b/.test(sentence)) continue;
      requirements++;
      const where = `${page}:${lineAt(blockStart)}`;
      const groups = [...sentence.matchAll(/\(([^()]*)\)/g)].map((m) => checkCitation(m[1], where)).filter((g) => g !== null);
      if (!groups.length) {
        problems.push(`${where}: a requirement with no citation of what enforces it: "${sentence.trim().slice(0, 110)}${sentence.length > 110 ? "…" : ""}"`);
        continue;
      }
      for (const g of groups) problems.push(...g);
    }
  }
}

// A rule counts as cited wherever the pages name it in a citation, not only beside a MUST: some
// rules (DSDS-24's warning) enforce a SHOULD.
for (const page of PAGES) {
  const text = fs.readFileSync(path.join(ROOT, page), "utf-8");
  for (const m of text.matchAll(/\(([^()]*)\)/g)) {
    for (const id of m[1].replace(/`/g, "").match(/DSDS-\d+/g) || []) cited.add(id);
  }
}

for (const id of semanticRules) {
  if (!cited.has(id)) problems.push(`${id} is a semantic rule, but neither ${PAGES.join(" nor ")} cites it as what enforces a requirement`);
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(
  `✓ ${requirements} requirement(s) in the specification and processing model each name what enforces them ` +
    `(${byKind.schema} schema, ${byKind.rule} rule, ${byKind.vector} vector, ${byKind.suite} suite, ${byKind.consumer} consumer citation(s)), ` +
    `and all ${semanticRules.length} semantic rules are cited.`,
);
