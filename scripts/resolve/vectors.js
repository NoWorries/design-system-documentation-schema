#!/usr/bin/env node
/**
 * Consumer test vectors: each folder in examples/vectors/ holds one or more DSDS documents and
 * an expected.json - what a conforming consumer works out from them under the processing model
 * (site/content/processing.mdx). This checks the reference resolver (resolve.js) against every
 * one, so the processing model and its implementation can't drift apart.
 *
 * Every .yaml file in a folder is one project (processing model §3), read in name order.
 *
 *   node scripts/resolve/vectors.js            # check every vector; exit 1 on a difference
 *   node scripts/resolve/vectors.js --update   # rewrite expected.json from the resolver
 *
 * --update is for adding a vector or deliberately changing the model. Read the diff before
 * committing it: expected.json is the spec's answer, not a snapshot of whatever the code does.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { rootDir, loadYaml } = require("../lib");
const { resolveProject } = require("./resolve");

const VECTORS_DIR = path.join(rootDir, "examples", "vectors");

function vectorDirs() {
  return fs
    .readdirSync(VECTORS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(VECTORS_DIR, e.name))
    .sort();
}

function inputsOf(dir) {
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
}

function run(dir) {
  return resolveProject(inputsOf(dir).map((f) => loadYaml(path.join(dir, f))));
}

// A problem's `message` is prose for people, so it isn't part of the contract: an
// implementation in another language only has to match each problem's `code` and `at`.
const comparable = (result) => ({ ...result, problems: result.problems.map(({ code, at }) => ({ code, at })) });

// The first place two JSON values differ, as a path, for a readable failure.
function firstDifference(a, b, at = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], `${at}/${k}`);
      if (d) return d;
    }
  }
  return { at: at || "/", expected: b, actual: a };
}

function main() {
  const update = process.argv.includes("--update");
  let failed = 0;
  const dirs = vectorDirs();
  for (const dir of dirs) {
    const name = path.relative(rootDir, dir);
    if (!inputsOf(dir).length) {
      console.error(`✗ ${name}: no .yaml input`);
      failed++;
      continue;
    }
    const actual = run(dir);
    const expectedPath = path.join(dir, "expected.json");
    if (update) {
      fs.writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`, "utf-8");
      console.log(`✓ ${name}: expected.json written`);
      continue;
    }
    if (!fs.existsSync(expectedPath)) {
      console.error(`✗ ${name}: no expected.json - write one with --update, then read it`);
      failed++;
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
    const diff = firstDifference(comparable(actual), comparable(expected));
    if (diff) {
      console.error(`✗ ${name}: differs at ${diff.at}\n    expected ${JSON.stringify(diff.expected)}\n    got      ${JSON.stringify(diff.actual)}`);
      failed++;
    } else {
      console.log(`✓ ${name}`);
    }
  }
  if (!update) console.log(`\n${dirs.length - failed} of ${dirs.length} consumer test vector(s) match.`);
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { vectorDirs, inputsOf };
