#!/usr/bin/env node
/**
 * Rewrites `.agents/skills/dsds-*` SKILL.md files so their frontmatter `metadata.version`,
 * URL fragments, `schemaVersion` literals, and other version strings point at the current (or
 * specified) spec version. Without an explicit version, reads the target from
 * schema/dsds.bundled.yaml's own `$id`, so running this after `npm run bundle` picks up a
 * freshly bumped version automatically.
 *
 * --check goes beyond the version string: it also fails if the highest `DSDS-XX` id any skill
 * mentions doesn't match the catalog's highest, or a skill cites a bundled-schema filename
 * bundle.js doesn't actually write - closing the failure mode where a version bump alone made
 * a skill look "in sync" while its rule-count references and paths were stale.
 *
 * Usage:
 *   node scripts/generate/sync-skill-versions.js              # use version from schema
 *   node scripts/generate/sync-skill-versions.js <version>    # explicit target version
 *   node scripts/generate/sync-skill-versions.js --dry-run    # preview only
 *   node scripts/generate/sync-skill-versions.js --check      # exit 1 if stale
 *   node scripts/generate/sync-skill-versions.js --help
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const BUNDLED_SCHEMA = path.join(ROOT, "schema", "dsds.bundled.yaml");
const SKILLS_DIR = path.join(ROOT, ".agents", "skills");

function readBundledVersion() {
  if (!fs.existsSync(BUNDLED_SCHEMA)) return null;
  const raw = fs.readFileSync(BUNDLED_SCHEMA, "utf-8");
  const match = /\/v([^/\s"']+)\/dsds\.bundled\.yaml/.exec(raw);
  return match ? match[1] : null;
}

function printHelp() {
  console.log(`
sync-skill-versions — sync agent skill DSDS version references

Usage:
  node scripts/generate/sync-skill-versions.js [<version>] [--dry-run]

Arguments:
  <version>    Target version string (ex: 0.20.1). If omitted, reads from
               schema/dsds.bundled.yaml's own $id.

Options:
  --dry-run    Print planned changes without writing files.
  --check      Exit 1 if any skill's version, rule-count reference, or
               bundled-schema filename is stale. Makes no changes.
  --help, -h   Show this help.
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const DRY_RUN = flags.has("--dry-run");
const CHECK = flags.has("--check");

let TARGET_VERSION;
if (positional.length > 1) {
  console.error("✗ Expected at most one positional argument: <version>");
  process.exit(1);
}

if (positional.length === 1) {
  TARGET_VERSION = positional[0];
} else {
  TARGET_VERSION = readBundledVersion();
  if (!TARGET_VERSION) {
    console.error(
      `✗ Could not read version from ${path.relative(ROOT, BUNDLED_SCHEMA)}'s own $id. ` +
        "Run `npm run bundle` first, or pass an explicit <version>.",
    );
    process.exit(1);
  }
}

if (!/^[A-Za-z0-9]+(\.[A-Za-z0-9-]+)*$/.test(TARGET_VERSION)) {
  console.error(`✗ Invalid version string: "${TARGET_VERSION}"`);
  process.exit(1);
}

const URL_REGEX = /designsystemdocspec\.org\/v([A-Za-z0-9.\-]+)\//g;
const NEW_URL_FRAGMENT = `designsystemdocspec.org/v${TARGET_VERSION}/`;
const SCHEMA_VERSION_LITERAL_REGEX = /(schemaVersion:\s*"?)([A-Za-z0-9.\-]+)("?)/g;
const FRONTMATTER_VERSION_REGEX = /(metadata:\s*\n\s*version:\s*)\S+/;

function rewriteUrlsInText(text) {
  let count = 0;
  const updated = text.replace(URL_REGEX, (match, foundVersion) => {
    if (foundVersion === TARGET_VERSION) return match;
    count++;
    return NEW_URL_FRAGMENT;
  });
  return { updated, count };
}

function rewriteSchemaVersionLiterals(text) {
  let count = 0;
  const updated = text.replace(SCHEMA_VERSION_LITERAL_REGEX, (match, before, oldVer, after) => {
    if (oldVer === TARGET_VERSION) return match;
    count++;
    return before + TARGET_VERSION + after;
  });
  return { updated, count };
}

if (!fs.existsSync(SKILLS_DIR)) {
  console.log("No .agents/skills directory found — nothing to do.");
  process.exit(0);
}

const skillFiles = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("dsds-"))
  .map((d) => path.join(SKILLS_DIR, d.name, "SKILL.md"))
  .filter((p) => fs.existsSync(p));

if (skillFiles.length === 0) {
  console.log("No dsds-* skill files found — nothing to do.");
  process.exit(0);
}

const CURRENT_SCHEMA_VERSION = readBundledVersion();

console.log(`Syncing agent skill versions to v${TARGET_VERSION}`);
if (DRY_RUN) console.log("(dry run — no files will be written)");
console.log();

let totalFiles = 0;
let totalReplacements = 0;
const changedFiles = [];

for (const file of skillFiles) {
  const original = fs.readFileSync(file, "utf-8");
  let text = original;
  let count = 0;

  // What version was this file's prose written against? Read from its own
  // frontmatter BEFORE the rewrite below overwrites it. This is the only
  // record of the outgoing version once bump-version.js has already
  // regenerated the bundle — see the catch-all's comment below for why
  // reading it from the bundle instead made that replacement dead code.
  const frontmatterMatch = original.match(FRONTMATTER_VERSION_REGEX);
  const PREVIOUS_VERSION = frontmatterMatch
    ? frontmatterMatch[0].slice(frontmatterMatch[1].length).trim()
    : null;

  // Frontmatter metadata.version → target version.
  text = text.replace(FRONTMATTER_VERSION_REGEX, (m, prefix) => {
    if (m.slice(prefix.length) === TARGET_VERSION) return m;
    count++;
    return prefix + TARGET_VERSION;
  });

  // Body: rewrite URLs and schemaVersion literals
  let r = rewriteUrlsInText(text);
  text = r.updated; count += r.count;

  r = rewriteSchemaVersionLiterals(text);
  text = r.updated; count += r.count;

  // Catch-all: remaining literal version strings the regexes don't cover —
  // bare prose like "the DSDS v0.20.0 bundled schema".
  //
  // PREVIOUS_VERSION, not CURRENT_SCHEMA_VERSION. This was gated on
  // `CURRENT_SCHEMA_VERSION !== TARGET_VERSION`, which made it dead code in
  // the one path that matters: bump-version.js runs `npm run bundle` BEFORE
  // it runs this script, so by the time we get here the bundle already says
  // the new version, both values are the target, and the guard skipped every
  // replacement. It only ever fired when someone passed an explicit version
  // that happened to differ from the bundle — i.e. not during a real bump.
  // That is how "the DSDS v0.20.0 bundled schema" survived the 0.20.1 bump
  // in dsds-validate/SKILL.md with `--check` reporting clean.
  //
  // PREVIOUS_VERSION is read from the skill files themselves (their
  // frontmatter `metadata.version`, captured before any rewriting), which is
  // the only place that still knows what version the prose was written
  // against.
  if (PREVIOUS_VERSION && PREVIOUS_VERSION !== TARGET_VERSION) {
    const before = text;
    text = text.replaceAll(PREVIOUS_VERSION, TARGET_VERSION);
    if (text !== before) {
      count += before.split(PREVIOUS_VERSION).length - 1;
    }
  }

  if (text !== original) {
    totalFiles++;
    totalReplacements += count;
    changedFiles.push(path.relative(ROOT, file));
    if (!DRY_RUN && !CHECK) fs.writeFileSync(file, text, "utf-8");
  }
}

const versionDrift = totalFiles > 0;

if (!CHECK) {
  if (totalFiles === 0) {
    console.log(`All skill files already at v${TARGET_VERSION}. Nothing to do.`);
    process.exit(0);
  }

  const action = DRY_RUN ? "Would update" : "Updated";
  console.log(`${action} ${totalFiles} file(s) (${totalReplacements} replacements):`);
  for (const f of changedFiles) console.log(`  ${f}`);
  console.log();

  if (DRY_RUN) {
    console.log("Dry run complete. Rerun without --dry-run to apply.");
  } else {
    console.log("✓ Skill versions synced.");
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --check: version drift (above) plus rule-count and bundle-filename drift.
// ---------------------------------------------------------------------------

let checkFailed = versionDrift;
if (versionDrift) {
  console.error(`✗ Version drift — ${totalFiles} file(s) not at v${TARGET_VERSION}:`);
  for (const f of changedFiles) console.error(`  ${f}`);
}

const CONFORMANCE_RULES = path.join(ROOT, "schema", "conformance-rules.yaml");
const RULE_ID_REGEX = /^- id: (DSDS-\d+)/gm;
let highestRealRuleId = null;
if (fs.existsSync(CONFORMANCE_RULES)) {
  const raw = fs.readFileSync(CONFORMANCE_RULES, "utf-8");
  const ids = [...raw.matchAll(RULE_ID_REGEX)].map((m) => m[1]);
  if (ids.length) {
    highestRealRuleId = ids.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).at(-1);
  }
}

// A skill that describes the whole catalog - a range starting at DSDS-01 - should end that
// range at the catalog's actual current top id, so it can't cite a stale rule count. Checks the
// file's own HIGHEST mention. A skill that only cites one tier (`DSDS-12`-`DSDS-21`, the advisory
// rules) isn't describing the catalog, so it isn't held to its newest id.
const RULE_ID_MENTION_REGEX = /DSDS-(\d+)/g;
const WHOLE_CATALOG_REGEX = /DSDS-01`?\s*(?:–|—|-|through|to)\s*`?DSDS-\d+/;
if (highestRealRuleId) {
  const highestRealN = Number(highestRealRuleId.slice(5));
  for (const file of skillFiles) {
    const text = fs.readFileSync(file, "utf-8");
    if (!WHOLE_CATALOG_REGEX.test(text)) continue;
    const mentioned = [...text.matchAll(RULE_ID_MENTION_REGEX)].map((m) => Number(m[1]));
    if (mentioned.length === 0) continue;
    const highestMentioned = Math.max(...mentioned);
    if (highestMentioned < highestRealN) {
      checkFailed = true;
      console.error(
        `✗ ${path.relative(ROOT, file)}: highest rule id mentioned is DSDS-${highestMentioned}, ` +
          `but the catalog's highest is ${highestRealRuleId} — this skill is citing a stale rule count.`,
      );
    }
  }
}

// A skill's bundled-schema filename should be one bundle.js actually writes.
const REAL_BUNDLE_FILENAMES = ["dsds.bundled.yaml", "dsds.bundled.schema.json"];
// Each dot-separated segment must start with a letter, so a sentence-ending period isn't
// swallowed into the filename (e.g. "see dsds.bundled.yaml." capturing the trailing dot).
const CITED_BUNDLE_FILENAME_REGEX = /dsds\.bundled\.[a-z]+(?:\.[a-z]+)*/g;
for (const file of skillFiles) {
  const text = fs.readFileSync(file, "utf-8");
  for (const m of text.matchAll(CITED_BUNDLE_FILENAME_REGEX)) {
    if (!REAL_BUNDLE_FILENAMES.includes(m[0])) {
      checkFailed = true;
      console.error(
        `✗ ${path.relative(ROOT, file)}: cites bundled-schema filename "${m[0]}", which ` +
          `scripts/generate/bundle.js doesn't write. Real filenames: ${REAL_BUNDLE_FILENAMES.join(", ")}`,
      );
    }
  }
}

if (checkFailed) {
  console.error("\nRun `npm run sync-skill-versions` for the version drift, and fix the rest by hand.");
  process.exit(1);
}
console.log(`✓ All skill files are in sync: version, rule-count range, and bundle filenames.`);
