#!/usr/bin/env node
/**
 * Editorial lint for DSDS documents (the advisory tier): schema validation and validate.js's
 * semantic rules answer "is this document allowed/consistent?", this answers "is this
 * documentation good?" It runs on documents that already validate, reports quality gaps, and
 * never fails the build - exit code is always 0 for a documentation finding.
 *
 * schema/conformance-rules.yaml is the source of truth: at startup this loads every
 * `enforcement: advisory` rule and runs its matching check implementation, keyed by rule
 * `name`. The only way this script exits non-zero is catalog/code drift (an advisory entry
 * with no implementation, or vice versa) - a tooling bug, not a documentation finding.
 *
 * Usage: node scripts/validate/lint-docs.js [--json] [paths…], or `npm run lint`. --help for more.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {
  rootDir,
  loadYaml,
  defaultTargets,
  isBaseDoc,
  declaredEnum,
  enumRanker,
} = require("../lib");

const CATALOG_PATH = path.join(rootDir, "schema/conformance-rules.yaml");

function loadCatalog() {
  return loadYaml(CATALOG_PATH);
}

/**
 * Build the active rule set: catalog rules with `enforcement: advisory`, joined to their
 * check implementations, exiting non-zero on drift in either direction. Two implementation
 * maps: IMPLEMENTATIONS runs once per entity via entriesIn(doc); DOCUMENT_IMPLEMENTATIONS
 * runs once per file against the raw parsed document, for rules about the document's own
 * top-level document rather than anything inside one entry.
 */
function activeRules() {
  const catalog = loadCatalog();
  const advisoryRules = catalog.filter((r) => r.enforcement === "advisory");

  const allImplNames = new Set([...Object.keys(IMPLEMENTATIONS), ...Object.keys(DOCUMENT_IMPLEMENTATIONS)]);
  const missingImpl = advisoryRules.filter((r) => !allImplNames.has(r.name));
  const catalogNames = new Set(advisoryRules.map((r) => r.name));
  const orphanImpl = [...allImplNames].filter((name) => !catalogNames.has(name));

  if (missingImpl.length || orphanImpl.length) {
    for (const r of missingImpl) {
      console.error(`✗ catalog drift: ${r.id} '${r.name}' is enforcement: advisory in schema/conformance-rules.yaml but has no implementation in scripts/validate/lint-docs.js`);
    }
    for (const name of orphanImpl) {
      console.error(`✗ catalog drift: '${name}' is implemented in scripts/validate/lint-docs.js but has no enforcement: advisory entry in schema/conformance-rules.yaml`);
    }
    process.exit(1);
  }

  return advisoryRules.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.name in DOCUMENT_IMPLEMENTATIONS ? "document" : "entity",
    check: IMPLEMENTATIONS[r.name] || DOCUMENT_IMPLEMENTATIONS[r.name],
  }));
}

// ---------------------------------------------------------------------------
// Check implementations, keyed by catalog rule `name`. Each receives (entry, emit) once per
// top-level entry/shared entity and calls emit(pointer, message) per finding, following the
// same "what's wrong + what to do" formula validate.js's error strings use.
// ---------------------------------------------------------------------------

function normalizeProse(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Every `guidelines` section item across an entry's sections, with a pointer for each.
function eachGuidelineItem(entry, fn) {
  (entry.sections || []).forEach((section, si) => {
    if (!section || section.kind !== "guidelines") return;
    (section.items || []).forEach((item, ii) => {
      if (item) fn(item, `/sections/${si}/items/${ii}`);
    });
  });
}

// ---------------------------------------------------------------------------
// STYLE_GUIDE.md's list orders (DSDS-18/19/21): sections, guideline items and entries. These
// are reading order, so they stay advice. Field order isn't checked here any more:
// scripts/format/format.js (dsds-format) applies it, and DSDS-17/20/22/23 are retired.
// ---------------------------------------------------------------------------

// Read from the schema enums, in the order each one declares its values. These used to be
// hand-kept tables here; the enums were reordered to match the guide, so the schema now
// records these orders and this file reads them instead of holding a second copy. Each ranker
// also picks up the `default` its schema declares, so a section that leaves `for` or `framing`
// out is ranked as the value a validator would read it as.
const KIND_AT = (d) => d.properties.kind.oneOf.find((m) => m.enum);
const ENTRY_KIND = declaredEnum("entries/entry.schema.yaml", KIND_AT);
const entryKindRank = enumRanker("entries/entry.schema.yaml", KIND_AT);
const SECTION_KIND = declaredEnum("sections/section.schema.yaml", KIND_AT);
// A namespaced custom kind ("acme.custom-section") isn't in the enum and has no defined place
// in the order, so it ranks last rather than being treated as unknown-and-therefore-equal.
const sectionKindRank = enumRanker("sections/section.schema.yaml", KIND_AT);

const AUDIENCE = declaredEnum("sections/section.schema.yaml", (d) => d.properties.for);
const audienceRank = enumRanker("sections/section.schema.yaml", (d) => d.properties.for);

const FRAMING_AT = (d) => d.allOf.find((m) => m.properties).properties.framing;
const FRAMING = declaredEnum("sections/guidelines.schema.yaml", FRAMING_AT);
const framingRank = enumRanker("sections/guidelines.schema.yaml", FRAMING_AT);

const LEVEL = declaredEnum("common/requirement-level.schema.yaml", (d) => d);
const levelRank = enumRanker("common/requirement-level.schema.yaml", (d) => d);

// STYLE_GUIDE.md §4's breadth scale: `when-to-use`, then `how-to-use`, in the order the schema
// lists `framing`. Until 0.22.0 a section declaring `tags` formed a third, narrowest tier. That
// made `tags` do two jobs - say what a section is about, and decide where it sits - so adding a
// tag to classify a section could move it. `tags` is classification only now.
const breadthRank = (section) => framingRank(section.framing);

const describeBreadth = (section) => `a \`framing: ${section.framing || FRAMING.fallback}\` section`;

const describeTier = (tier) => `both ${FRAMING.values[tier]}`;

// How a section's audience reads once the schema's default is applied, for use in messages.
// A section that leaves `for` out is ranked as the default, so it has to be named as the
// default too - printing "for: undefined" would describe the document rather than the problem.
function describeAudience(section) {
  return section.for === undefined ? `${AUDIENCE.fallback} (defaulted)` : section.for;
}

// Every entity in a document, with a JSON pointer to it. A standalone entry file is its own
// single entity; entriesIn() flattens both cases but drops the position, which the messages need.
function entitiesWithPointers(doc) {
  const out = [];
  (doc.entries || []).forEach((e, i) => out.push([e, `/entries/${i}`]));
  (doc.shared || []).forEach((e, i) => out.push([e, `/shared/${i}`]));
  if (doc.id && !Array.isArray(doc.entries)) out.push([doc, ""]);
  return out;
}

// Returns the first out-of-order pair, or null if `actual` is already non-decreasing by
// canonical rank - the general "is this sequence sorted" check DSDS-18/19/21 all reduce to.
function firstInversion(actual, rankOf) {
  for (let i = 1; i < actual.length; i++) {
    if (rankOf(actual[i]) < rankOf(actual[i - 1])) return [actual[i - 1], actual[i]];
  }
  return null;
}

const IMPLEMENTATIONS = {
  // Normalizes both strings and flags an exact restatement or a bare value literal.
  "token-description-restates-identifier": (entry, emit) => {
    if (entry.kind !== "token") return;
    const desc = entry.description;
    if (typeof desc !== "string" || !desc.trim()) return;
    const raw = desc.trim();
    const d = normalizeProse(desc);
    if (!d) return;
    const id = normalizeProse(entry.id || "");
    const name = normalizeProse(entry.name || "");
    const restatesName = (id && d === id) || (name && d === name);
    const isBareValue =
      /^#[0-9a-f]{3,8}$/i.test(raw) ||
      /^(rgb|hsl)a?\([^)]*\)$/i.test(raw) ||
      /^-?\d*\.?\d+(px|rem|em|%|pt|vh|vw)?$/i.test(raw);
    if (restatesName || isBareValue) {
      emit(
        "/description",
        `token "${entry.id}" has a description that only ${restatesName ? "restates its id or name" : "gives a raw value"} — a token description should state the token's role or when to use it, not repeat what the id or the DTCG source value already says. Drop it (description is optional here) or state its purpose.`,
      );
    }
  },

  "component-missing-when-to-use": (entry, emit) => {
    if (entry.kind !== "component") return;
    const hasWhenToUse = (entry.sections || []).some(
      (s) => s && s.kind === "guidelines" && s.framing === "when-to-use",
    );
    if (!hasWhenToUse) {
      emit(
        "/sections",
        `component "${entry.id}" has no guidelines section with framing: when-to-use — "when do I use this?" is usually the first question documentation must answer. Add one, or note in metadata why it doesn't apply.`,
      );
    }
  },

  // The scale-position companion to token-description-restates-identifier (DSDS-13): flags a
  // description that reduces to a single leading scale word plus a number and nothing else -
  // the ordinal the id and the token's metadata.group position already carry.
  "token-description-restates-scale-position": (entry, emit) => {
    if (entry.kind !== "token") return;
    const desc = entry.description;
    if (typeof desc !== "string" || !desc.trim()) return;
    const d = normalizeProse(desc);
    if (!d) return;
    // A description that restates the id or name is DSDS-13's case; leave it there so one
    // that is both is reported once, not twice.
    const id = normalizeProse(entry.id || "");
    const name = normalizeProse(entry.name || "");
    if ((id && d === id) || (name && d === name)) return;
    // A single leading scale word plus a number, and nothing else ("shade 900", "level 6 of
    // the neutral scale"). Kept narrow: the scale word must lead and be singular, so
    // number-first/plural forms and any role/usage word leave it alone. See DSDS-16's note.
    const SW = "(?:level|step|shade|tint|grade|weight|size|swatch)";
    const N = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
    const scaleOnly = [
      new RegExp(`^${SW} ${N}$`),
      new RegExp(`^${SW} ${N} of the [a-z]+ (?:scale|ramp)$`),
    ];
    if (scaleOnly.some((re) => re.test(d))) {
      emit(
        "/description",
        `token "${entry.id}" has a description that only restates its scale position — a token description should state the token's role or when to use it, not repeat the ordinal the id and its place in the scale already carry. Drop it (description is optional here) or state its purpose.`,
      );
    }
  },

  // STYLE_GUIDE.md §4 - same-kind sections must stay contiguous and general-to-specific
  // (guidelines, definitions, steps, section); among guidelines sections, breadth decides
  // first (when-to-use, how-to-use, then about-one-tag), then audience (all, human, agent)
  // within one breadth tier.
  "section-order": (entry, emit) => {
    const sections = entry.sections;
    if (!Array.isArray(sections) || sections.length < 2) return;
    // A section with no `kind` is read as the default its schema declares, so name that in the
    // message instead of printing `undefined`.
    const kindLabel = (s) => (s && s.kind !== undefined ? s.kind : `${SECTION_KIND.fallback} (defaulted)`);
    const kindInversion = firstInversion(sections, (s) => sectionKindRank(s.kind));
    if (kindInversion) {
      emit(
        "/sections",
        `"${entry.id}" has a "${kindLabel(kindInversion[0])}" section before a "${kindLabel(kindInversion[1])}" section, out of STYLE_GUIDE.md's grouping — same-kind sections stay contiguous, ordered ${SECTION_KIND.values.join(", ")} (general to specific).`,
      );
      return; // fix grouping first - the framing check below assumes the guidelines sections are already one contiguous run
    }
    const guidelinesRun = sections.filter((s) => s.kind === "guidelines");
    const breadthInversion = firstInversion(guidelinesRun, breadthRank);
    if (breadthInversion) {
      emit(
        "/sections",
        `"${entry.id}" has ${describeBreadth(breadthInversion[0])} before ${describeBreadth(breadthInversion[1])} — STYLE_GUIDE.md §4 orders guidelines sections ${FRAMING.values.join(", ")}.`,
      );
      return; // fix breadth first - the audience sort below only orders sections that TIE on breadth
    }
    // Audience, within one breadth tier only. Grouping first is what keeps the two sorts
    // composed in the right order: a `for: agent` when-to-use section legitimately precedes a
    // `for: all` how-to-use one, and a `for: all` tag-scoped section legitimately follows a
    // `for: human` one, so comparing across tiers on `for` would be a false positive.
    const byBreadth = new Map();
    for (const s of guidelinesRun) {
      const tier = breadthRank(s);
      if (!byBreadth.has(tier)) byBreadth.set(tier, []);
      byBreadth.get(tier).push(s);
    }
    for (const [tier, run] of byBreadth) {
      const audienceInversion = firstInversion(run, (s) => audienceRank(s.for));
      if (audienceInversion) {
        emit(
          "/sections",
          `"${entry.id}" has a \`for: ${describeAudience(audienceInversion[0])}\` guidelines section before a \`for: ${describeAudience(audienceInversion[1])}\` one (${describeTier(tier)}) — STYLE_GUIDE.md orders audience ${AUDIENCE.values.join(", ")}, broadest readership first.`,
        );
        break;
      }
    }
  },

};

// Every item id declared anywhere on an entity, keyed to the item object - mirrors
// validate.js's collectItemsById, which DSDS-10's same-as level check (validateSameAsLevels)
// already uses to resolve a same-as ref's target. Reimplemented locally rather than shared:
// lint-docs.js and validate.js only share lib.js's document-shape helpers (entriesIn,
// findRefs, …), not resolution logic, and this is small enough that adding a new shared
// module for one caller each would be more indirection than the fix needs.
function collectItemsById(entity) {
  const byId = new Map();
  function walk(item) {
    if (!item || typeof item !== "object") return;
    if (typeof item.id === "string") byId.set(item.id, item);
    for (const value of Object.values(item)) {
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
      }
    }
  }
  for (const section of entity.sections || []) {
    for (const item of section.items || []) walk(item);
    for (const item of section.freeform || []) walk(item);
  }
  for (const trait of entity.traits || []) walk(trait);
  return byId;
}

// The items a guideline item's same-as refs point at, looked up in this document only. Each
// result is { found: true, item } for a target in this document, or { found: false } for one
// whose entry isn't here (a cross-file same-as), which these rules can't see into.
function sameAsTargets(item, itemsByEntityId) {
  const out = [];
  for (const ref of item.refs || []) {
    if (!ref || ref.rel !== "same-as" || typeof ref.to !== "string") continue;
    const hashIdx = ref.to.indexOf("#");
    if (hashIdx === -1) continue;
    const targetItems = itemsByEntityId.get(ref.to.slice(0, hashIdx));
    if (!targetItems) {
      out.push({ found: false });
      continue;
    }
    const targetItem = targetItems.get(ref.to.slice(hashIdx + 1));
    if (targetItem) out.push({ found: true, item: targetItem });
  }
  return out;
}

// Document-scoped rules run once per file, against the raw parsed document, instead of once
// per entity - see activeRules()'s own comment.
const DOCUMENT_IMPLEMENTATIONS = {
  // A hard-requirement guideline (level: must/must-not) with no checkedBy at all is invisible
  // to any dashboard built off it. DSDS-03 already blocks the narrower case (checkedBy:
  // automated with no checks ref); this flags checkedBy left out entirely - unless the item
  // borrows its content via a same-as ref (DSDS-10's rel) whose target declares checkedBy, in
  // which case it inherits that too and isn't actually invisible to tooling.
  //
  // This has to be document-scoped rather than entity-scoped: a same-as ref commonly points at
  // a canonical item on a *different* top-level entry in the same document (e.g. several
  // components' guideline items pointing at one shared-a11y entry's canonical rules), and
  // IMPLEMENTATIONS' checks only ever see one entity via entriesIn(doc) - never its siblings.
  // Moving here gives the check the whole parsed document, the same way validateSameAsLevels
  // (DSDS-10, validate.js) resolves same-as targets. Only resolves within this document, like
  // validateSameAsLevels's local pass - a same-as ref to another file (resolveWiderScope's
  // wider-scope case) is out of scope here too, matching the actual bug found (a single
  // document with a shared entry) and keeping this fix from growing beyond it.
  "guideline-missing-checkedby": (doc, emit) => {
    const entities = entitiesWithPointers(doc);
    const itemsByEntityId = new Map(entities.map(([entity]) => [entity.id, collectItemsById(entity)]));

    // True if some same-as ref on this item defers checkedBy to its target. Two cases:
    //  - the target is in this document and declares checkedBy: it inherits it.
    //  - the target's entry isn't in this document at all (a cross-file same-as): this rule
    //    can't see what the target declares, so it stays silent rather than demanding the
    //    pointer restate it. Restating it would also mean restating the target's `checks`
    //    to satisfy DSDS-03 - the duplication the pointer form exists to avoid. Whether the
    //    target exists is DSDS-05/DSDS-08's job, not this rule's.
    // A same-as ref to a target in this document with no checkedBy still leaves the item
    // unresolved, so it's correctly flagged.
    function inheritsCheckedBy(item) {
      return sameAsTargets(item, itemsByEntityId).some((t) => !t.found || Boolean(t.item.checkedBy));
    }

    for (const [entity, at] of entities) {
      eachGuidelineItem(entity, (item, p) => {
        if ((item.level === "must" || item.level === "must-not") && !item.checkedBy && !inheritsCheckedBy(item)) {
          emit(
            `${at}${p}/checkedBy`,
            `guideline in "${entity.id}" is a hard requirement (level: ${item.level}) with no checkedBy, and no same-as target that declares one — declare 'automated', 'assisted', or 'manual' so a tool can tell whether this rule is verifiable at all.`,
          );
        }
      });
    }
  },

  // STYLE_GUIDE.md §5 - must, should, may, should-not, must-not. Items sharing a level keep
  // their relative order; only a strict level-to-level inversion is flagged.
  //
  // An item that leaves `level` out takes it from its same-as target (DSDS-10), so it's ranked
  // at that level. That's why this rule is document-scoped: the target is usually on another
  // entry in the same document. If the level can't be found here (the target is in another
  // file), the item is left out of the comparison rather than guessed at.
  "guideline-item-level-order": (doc, emit) => {
    const entities = entitiesWithPointers(doc);
    const itemsByEntityId = new Map(entities.map(([entity]) => [entity.id, collectItemsById(entity)]));

    function effectiveLevel(item) {
      if (item.level !== undefined) return { level: item.level, borrowed: false };
      const target = sameAsTargets(item, itemsByEntityId).find((t) => t.found && t.item.level !== undefined);
      return target ? { level: target.item.level, borrowed: true } : null;
    }
    const describe = ({ level, borrowed }) => `level: ${level}${borrowed ? " (from its same-as target)" : ""}`;

    for (const [entity, at] of entities) {
      (entity.sections || []).forEach((section, si) => {
        if (!section || section.kind !== "guidelines" || !Array.isArray(section.items)) return;
        const ranked = section.items.map(effectiveLevel).filter(Boolean);
        const inversion = firstInversion(ranked, (it) => levelRank(it.level));
        if (inversion) {
          emit(
            `${at}/sections/${si}/items`,
            `"${entity.id}" has a ${describe(inversion[0])} item before a ${describe(inversion[1])} one — STYLE_GUIDE.md orders guideline items ${LEVEL.values.join(", ")}.`,
          );
        }
      });
    }
  },

  // STYLE_GUIDE.md §1 - entries[] runs system, token, theme, component, entry, then any
  // namespaced custom kind. Order within one kind is not checked: the guide asks for
  // "whatever order reads best" there, which is a judgment, not a computation.
  "entry-order": (doc, emit) => {
    const entries = doc.entries;
    if (!Array.isArray(entries) || entries.length < 2) return;
    const inversion = firstInversion(entries, (e) => entryKindRank(e && e.kind));
    if (inversion) {
      emit(
        "/entries",
        `"${inversion[0].id}" (kind: ${inversion[0].kind}) comes before "${inversion[1].id}" (kind: ${inversion[1].kind}) — STYLE_GUIDE.md §1 orders entries ${ENTRY_KIND.values.join(", ")}, then any custom kind, so nothing precedes what it's built on.`,
      );
    }
  },

};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const SITE_URL = "https://designsystemdocspec.org";

const HELP = `Usage: dsds-lint [options] [file-or-folder ...]

Checks DSDS documents for documentation quality: the advisory rules
(DSDS-13 and up). Findings are suggestions, never failures, so the exit code is
0 whatever it finds. Run dsds-validate first; this assumes a valid document.
With no paths, lints the examples that ship with DSDS.

Options:
  --json        Print one JSON report to stdout instead of text.
  --self-check  Only check that every advisory rule in the catalog has an
                implementation here, and the reverse. Exits 1 if not.
  -h, --help    Show this help.

In --json output, each finding has:
  rule      The rule id (DSDS-XX).
  severity  Always "warning".
  pointer   Where the problem is, as a JSON Pointer into the document. When
            the fix is to add a missing field, it names where that field goes.
  message   What's wrong.
  fix       How to fix it.
  docs      The rule's section on the Conformance page.

Rules: ${SITE_URL}/conformance#rule-details
`;

// Each entity in a document with its JSON Pointer, matching entriesIn()'s order. Entity-scope
// checks emit pointers relative to the entity; this is what turns them into document pointers.
function entitiesForLint(doc) {
  if (!isBaseDoc(doc)) return [[doc, ""]];
  return [
    ...(doc.entries || []).map((entity, i) => [entity, `/entries/${i}`]),
    ...(doc.shared || []).map((entity, i) => [entity, `/shared/${i}`]),
  ];
}

function main() {
  const KNOWN_FLAGS = new Set(["--self-check", "--json", "--help", "-h"]);
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const unknown = argv.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    console.error(`Unknown option: ${unknown.join(", ")}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }

  // `--self-check` runs activeRules()'s catalog/implementation drift gate and stops. CI runs
  // the findings pass under continue-on-error (they're advisory), which used to swallow this
  // gate too - a catalog rule with no implementation only failed the build indirectly, via the
  // prose-range guards. This mode is a separate, blocking step.
  const selfCheckOnly = argv.includes("--self-check");
  const json = argv.includes("--json");
  const rules = activeRules();
  if (selfCheckOnly) {
    console.log(
      `✓ All ${rules.length} advisory rule(s) in schema/conformance-rules.yaml have an ` +
        `implementation in scripts/validate/lint-docs.js, and vice versa.`,
    );
    return;
  }

  const fixById = new Map(loadCatalog().map((r) => [r.id, r.fix]));
  const args = argv.filter((a) => !KNOWN_FLAGS.has(a));
  const targets = args.length
    ? args.flatMap((t) => {
        const stat = fs.existsSync(t) && fs.statSync(t);
        if (!stat) {
          console.error(`✗ Not found: ${t}`);
          return [];
        }
        if (stat.isFile()) return [t];
        return fs.readdirSync(t).filter((f) => f.endsWith(".yaml")).map((f) => path.join(t, f));
      })
    : defaultTargets();

  if (!json) {
    console.log("\nDSDS Doc Lint (warnings only — never fails the build)");
    console.log(`  ${rules.length} rule(s) from schema/conformance-rules.yaml: ${rules.map((r) => r.id).join(", ")}\n`);
  }

  let totalFindings = 0;
  let cleanFiles = 0;
  const files = [];

  for (const target of targets) {
    let doc;
    try {
      doc = loadYaml(target);
    } catch {
      continue; // not this tool's job - validate.js reports parse errors
    }
    if (!doc || typeof doc !== "object") continue;
    const rel = path.relative(process.cwd(), target);
    const findings = [];
    for (const rule of rules) {
      if (rule.scope !== "document") continue;
      rule.check(doc, (p, message) => findings.push({ id: rule.id, rule: rule.name, path: p, pointer: p, message }));
    }
    for (const [entry, entryPointer] of entitiesForLint(doc)) {
      for (const rule of rules) {
        if (rule.scope === "document") continue;
        rule.check(entry, (p, message) => findings.push({ id: rule.id, rule: rule.name, path: p, pointer: `${entryPointer}${p}`, message }));
      }
    }
    totalFindings += findings.length;
    if (findings.length === 0) cleanFiles++;

    if (json) {
      files.push({
        file: rel,
        warnings: findings.length,
        findings: findings.map((f) => ({
          rule: f.id,
          severity: "warning",
          pointer: f.pointer,
          message: f.message,
          fix: fixById.get(f.id) || null,
          docs: `${SITE_URL}/conformance#${f.id.toLowerCase()}`,
        })),
      });
      continue;
    }
    if (findings.length === 0) continue;
    console.log(`  ${rel}`);
    for (const f of findings) {
      console.log(`    ⚠ [${f.id} ${f.rule}] ${f.path}: ${f.message}`);
    }
    console.log("");
  }

  if (json) {
    const report = {
      tool: "dsds-lint",
      rules: rules.map((r) => r.id),
      summary: { files: files.length, clean: cleanFiles, warnings: totalFindings },
      files,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(`  ${targets.length} file(s) linted: ${cleanFiles} clean, ${totalFindings} warning(s).\n`);
}

main();
