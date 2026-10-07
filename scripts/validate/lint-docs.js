#!/usr/bin/env node
/**
 * Editorial lint for DSDS documents (the advisory tier): schema validation and validate.js's
 * DSDS-01-10 answer "is this document allowed/consistent?", this answers "is this
 * documentation good?" It runs on documents that already validate, reports quality gaps, and
 * never fails the build - exit code is always 0 for a documentation finding.
 *
 * schema/conformance-rules.yaml is the source of truth: at startup this loads every
 * `enforcement: advisory` rule and runs its matching check implementation, keyed by rule
 * `name`. The only way this script exits non-zero is catalog/code drift (an advisory entry
 * with no implementation, or vice versa) - a tooling bug, not a documentation finding.
 *
 * Usage: node scripts/validate/lint-docs.js [paths…], or `npm run lint`.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const {
  rootDir,
  schemaDir,
  loadYaml,
  defaultTargets,
  entriesIn,
  declaredProps,
  entryFieldOrder,
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

const LOWERCASE_RFC_REGEX = /(?<![A-Za-z])(must|should)(?: not)?(?![A-Za-z])/g;

// ---------------------------------------------------------------------------
// STYLE_GUIDE.md's canonical orders (DSDS-17/18/19/20). Field order comes from the schema
// files; the rank tables further down do not, because they order the items inside an array
// and no schema file has an opinion about that. Those are kept in sync with the guide by hand.
// ---------------------------------------------------------------------------

// Read out of the schema files, not transcribed from them. STYLE_GUIDE.md's rule is to
// follow the order the schema lists, so reading that order at runtime is the only honest way
// to check it - a hardcoded table here would be a second source of truth for the exact thing
// the guide says has one, and it drifted twice before this became derived (a stale
// `related`/`extends` order, and `imports` in the wrong place). See lib.js's
// `entryFieldOrder` for how the two lists compose.
const SHARED_FIELD_ORDER = declaredProps("shared.schema.yaml");
const DOCUMENT_FIELD_ORDER = declaredProps("base.schema.yaml");
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

// STYLE_GUIDE.md §4's breadth scale has three tiers, not two: `when-to-use`, then
// `how-to-use`, then a section that is really about one tag. The third isn't a field - it is
// true when every item names the same tag - so unlike the other sorts it has to be read out of
// the items rather than off the section's own fields.
const TAG_TIER = FRAMING.values.length;

// The tag a section declares itself to be about, or null.
//
// This used to be inferred: a section counted as tag-scoped when it had two or more items and
// every one of them named the same tag. That read the author's intent off the data, and got it
// wrong in three ways. Two sections with one accessibility rule each sat mid-run while
// twenty-eight with two or more sat last, all of them correct and none of it inferable from the
// corpus. Adding a second rule to a section silently moved it. And a section could hold ten
// tagged items and still not qualify, because the intersection across them was empty - tier
// depending on set intersection is not something an author will predict.
//
// `tags` on a section says it outright. The first tag is the scope, matching `metadata.tags`'s
// own convention, and the two-item rule is gone with the inference that needed it.
function sectionTag(section) {
  const tags = section.tags;
  if (!Array.isArray(tags) || tags.length === 0) return null;
  const first = tags[0];
  return typeof first === "string" && first.trim() !== "" ? first : null;
}

// A tag-scoped section is the narrowest tier whatever its `framing`, so this replaces the
// framing rank rather than composing with it.
const breadthRank = (section) => (sectionTag(section) ? TAG_TIER : framingRank(section.framing));

function describeBreadth(section) {
  const tag = sectionTag(section);
  return tag
    ? `a section about one tag (\`${tag}\`)`
    : `a \`framing: ${section.framing || FRAMING.fallback}\` section`;
}

const describeTier = (tier) =>
  tier === TAG_TIER ? "both about one tag" : `both ${FRAMING.values[tier]}`;

// How a section's audience reads once the schema's default is applied, for use in messages.
// A section that leaves `for` out is ranked as the default, so it has to be named as the
// default too - printing "for: undefined" would describe the document rather than the problem.
function describeAudience(section) {
  return section.for === undefined ? `${AUDIENCE.fallback} (defaulted)` : section.for;
}

// ---------------------------------------------------------------------------
// STYLE_GUIDE.md §3/§4/§5/§6's orders, for the smaller objects. Same approach as the entry
// orders above: read out of the schema files, never transcribed.
// ---------------------------------------------------------------------------

const EXT_KEY = "$extensions";

// An object built from a shared file plus a more specific one, joined the way §1 joins an
// entry's: shared fields first, then the specific file's own, then `$extensions` last.
function composedOrder(baseFile, memberFile) {
  const base = declaredProps(baseFile);
  const own = declaredProps(memberFile).filter((k) => !base.includes(k));
  return [...base.filter((k) => k !== EXT_KEY), ...own, EXT_KEY];
}

function itemOrder(kind) {
  const doc = loadYaml(path.join(schemaDir, "sections", `${kind}.schema.yaml`));
  const inline = (doc.allOf || []).find((m) => m.properties);
  return Object.keys(inline.properties.items.items.properties);
}

const METADATA_ORDER = {
  entry: composedOrder("metadata/metadata.schema.yaml", "metadata/entry-metadata.schema.yaml"),
  system: composedOrder("metadata/metadata.schema.yaml", "metadata/system-metadata.schema.yaml"),
};
const ITEM_ORDER = {
  guidelines: itemOrder("guidelines"),
  definitions: itemOrder("definitions"),
  steps: itemOrder("steps"),
};
const COMBO_ORDER = declaredProps("common/combo.schema.yaml");
// ref.schema.yaml is a oneOf (a bare string, or the object form) - the object form is the
// only branch with fields to order.
const REF_ORDER = Object.keys(
  loadYaml(path.join(schemaDir, "common", "ref.schema.yaml")).oneOf.find((m) => m.properties).properties,
);

// §4: a section leads with `kind`, `for`, then the one field its kind adds, then the rest of
// the shared order. The only object whose two lists interleave rather than concatenate.
const SECTION_KIND_FIELD = { guidelines: "framing", steps: "ordered" };
const SECTION_TAIL = declaredProps("sections/section.schema.yaml").filter(
  (k) => k !== "kind" && k !== "for",
);
function sectionFieldOrder(kind) {
  const own = SECTION_KIND_FIELD[kind];
  return ["kind", "for", ...(own ? [own] : []), ...SECTION_TAIL];
}

// §2: a trait leads with the two tags that identify it - `traitType`, then `kind` - then the
// fields every trait shares, then whatever else its own branch adds. Interleaves the same way
// a section does, so like a section the two-field lead is stated here and both lists are read
// out of the schema. declaredProps() can't be used: a trait's shared fields live in a `$defs`
// entry the branches `$ref`, not in a file's own `properties`.
const TRAIT_LEAD = ["traitType", "kind"];
const COMPONENT_SCHEMA = loadYaml(path.join(schemaDir, "entries", "component.schema.yaml"));
const TRAIT_BRANCHES =
  COMPONENT_SCHEMA.allOf.find((m) => m.properties).properties.traits.items.anyOf;
const TRAIT_VALUE_PROPS = Object.keys(COMPONENT_SCHEMA.$defs.traitValue.properties);
// A trait's `values[]` are traitValues with `refs` added.
const TRAIT_VALUE_ORDER = [...TRAIT_VALUE_PROPS, "refs"];

const branchProps = (branch) => Object.keys((branch.allOf || []).find((m) => m.properties)?.properties || {});

function traitFieldOrder(kind) {
  const branch = TRAIT_BRANCHES.find((b) => branchProps(b).includes("kind") &&
    (b.allOf.find((m) => m.properties).properties.kind || {}).const === kind);
  // An unknown or missing `kind` still has the shared fields to order; the branch-only tail
  // is simply unknown, so it contributes nothing rather than guessing a branch.
  const tail = branch
    ? branchProps(branch).filter((k) => !TRAIT_LEAD.includes(k) && !TRAIT_VALUE_PROPS.includes(k))
    : [];
  return [...TRAIT_LEAD, ...TRAIT_VALUE_PROPS, ...tail];
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
// canonical rank - the general "is this sequence sorted" check DSDS-17/18/19/20 all reduce to.
function firstInversion(actual, rankOf) {
  for (let i = 1; i < actual.length; i++) {
    if (rankOf(actual[i]) < rankOf(actual[i - 1])) return [actual[i - 1], actual[i]];
  }
  return null;
}

const IMPLEMENTATIONS = {
  "rfc-keywords-lowercase-in-normative-prose": (entry, emit) => {
    eachGuidelineItem(entry, (item, p) => {
      if (typeof item.statement !== "string") return;
      const hits = item.statement.match(LOWERCASE_RFC_REGEX);
      if (hits) {
        emit(
          `${p}/statement`,
          `guideline in "${entry.id}" uses lowercase '${hits[0]}' in its statement — capitalize RFC 2119 keywords in normative prose (${hits[0].toUpperCase()}) so the conformance weight is explicit.`,
        );
      }
    });
  },

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

  // STYLE_GUIDE.md §2 - only checks the relative order of fields actually present, so an
  // entry that leaves a field out is never flagged for its absence.
  "entry-field-order": (entry, emit) => {
    // A namespaced custom kind (`acme.icon-library`) has no schema file of its own, so it
    // falls back to the bare envelope - the same fallback entry.schema.yaml's dispatch gives it.
    const order = entry.kind === undefined ? SHARED_FIELD_ORDER : entryFieldOrder(entry.kind);
    const actual = Object.keys(entry).filter((k) => order.includes(k));
    const inversion = firstInversion(actual, (k) => order.indexOf(k));
    if (inversion) {
      const source = entry.kind === undefined
        ? "shared.schema.yaml"
        : `entries/entry.schema.yaml, then entries/${entry.kind}.schema.yaml`;
      emit(
        "",
        `"${entry.id}" has \`${inversion[0]}\` before \`${inversion[1]}\` — STYLE_GUIDE.md §2 says match the spec's own declared order, which for a ${entry.kind || "shared"} entry (${source}) is [${order.join(", ")}]. Actual order here: [${actual.join(", ")}].`,
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
        `"${entry.id}" has ${describeBreadth(breadthInversion[0])} before ${describeBreadth(breadthInversion[1])} — STYLE_GUIDE.md §4 orders guidelines sections ${FRAMING.values.join(", ")}, then sections about one tag.`,
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

  // STYLE_GUIDE.md §5 - must, should, may, should-not, must-not. Items sharing a level keep
  // their relative order; only a strict level-to-level inversion is flagged.
  "guideline-item-level-order": (entry, emit) => {
    (entry.sections || []).forEach((section, si) => {
      if (!section || section.kind !== "guidelines" || !Array.isArray(section.items)) return;
      const inversion = firstInversion(section.items, (it) => levelRank(it.level));
      if (inversion) {
        emit(
          `/sections/${si}/items`,
          `"${entry.id}" has a level: ${inversion[0].level} item before a level: ${inversion[1].level} one — STYLE_GUIDE.md orders guideline items ${LEVEL.values.join(", ")}.`,
        );
      }
    });
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
      return (item.refs || []).some((ref) => {
        if (!ref || ref.rel !== "same-as" || typeof ref.to !== "string") return false;
        const hashIdx = ref.to.indexOf("#");
        if (hashIdx === -1) return false;
        const targetItems = itemsByEntityId.get(ref.to.slice(0, hashIdx));
        if (!targetItems) return true;
        const targetItem = targetItems.get(ref.to.slice(hashIdx + 1));
        return Boolean(targetItem && targetItem.checkedBy);
      });
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

  // STYLE_GUIDE.md §3/§4/§5/§6 - the field order of every object nested inside an entry.
  "nested-field-order": (doc, emit) => {
    const check = (label, pointer, obj, order) => {
      const present = Object.keys(obj).filter((k) => order.includes(k));
      const inversion = firstInversion(present, (k) => order.indexOf(k));
      if (inversion) {
        emit(
          pointer,
          `${label} has \`${inversion[0]}\` before \`${inversion[1]}\` — its schema file declares [${order.filter((k) => present.includes(k)).join(", ")}].`,
        );
      }
    };

    // Refs turn up all over an entry (`refs`, `related`, `extends`, `evidence`, `checks`,
    // `specs`, `source`, …), so they're found by what they contain rather than by field name. `$extensions`
    // is skipped: it holds vendor data, and an object in there carrying `href` is not a ref.
    const walkRefs = (node, pointer) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walkRefs(v, `${pointer}/${i}`));
        return;
      }
      if ("to" in node || "href" in node) check("a ref", pointer, node, REF_ORDER);
      for (const [key, value] of Object.entries(node)) {
        if (key === EXT_KEY) continue;
        if (value && typeof value === "object") walkRefs(value, `${pointer}/${key}`);
      }
    };

    for (const [entity, at] of entitiesWithPointers(doc)) {
      if (!entity || typeof entity !== "object") continue;
      if (entity.metadata && typeof entity.metadata === "object") {
        const order = entity.kind === "system" ? METADATA_ORDER.system : METADATA_ORDER.entry;
        check("a `metadata` block", `${at}/metadata`, entity.metadata, order);
      }
      (entity.combos || []).forEach((combo, ci) => {
        if (combo && typeof combo === "object") check("a `combo`", `${at}/combos/${ci}`, combo, COMBO_ORDER);
      });
      (entity.traits || []).forEach((trait, ti) => {
        if (!trait || typeof trait !== "object") return;
        const traitAt = `${at}/traits/${ti}`;
        check("a trait", traitAt, trait, traitFieldOrder(trait.kind));
        (trait.values || []).forEach((value, vi) => {
          if (value && typeof value === "object") {
            check("a trait value", `${traitAt}/values/${vi}`, value, TRAIT_VALUE_ORDER);
          }
        });
      });
      (entity.sections || []).forEach((section, si) => {
        if (!section || typeof section !== "object") return;
        const sectionAt = `${at}/sections/${si}`;
        check("a section", sectionAt, section, sectionFieldOrder(section.kind));
        if (section.metadata && typeof section.metadata === "object") {
          check("a section's `metadata`", `${sectionAt}/metadata`, section.metadata, METADATA_ORDER.entry);
        }
        const order = ITEM_ORDER[section.kind];
        if (!order) return;
        (section.items || []).forEach((item, ii) => {
          if (item && typeof item === "object") {
            check(`a ${section.kind} item`, `${sectionAt}/items/${ii}`, item, order);
          }
        });
      });
    }
    walkRefs(doc, "");
  },

  // STYLE_GUIDE.md §6 - combos[] sorts by subject, then by level within one subject.
  "combo-order": (doc, emit) => {
    for (const [entity, at] of entitiesWithPointers(doc)) {
      const combos = entity && entity.combos;
      if (!Array.isArray(combos) || combos.length < 2) continue;
      // Contiguity, not a sort. STYLE_GUIDE.md's global rule is "don't alphabetize", and §6's
      // reason for grouping by subject is that a reader checking one trait finds all its rules
      // together - which a string sort is one way to achieve but not the requirement. So this
      // only reports a subject that appears, stops, and appears again.
      const seen = new Set();
      for (let i = 0; i < combos.length; i++) {
        const subject = String(combos[i] && combos[i].subject);
        const prevSubject = i > 0 ? String(combos[i - 1].subject) : null;
        if (subject !== prevSubject) {
          if (seen.has(subject)) {
            emit(
              `${at}/combos`,
              `subject "${subject}" appears again after another subject came in between — STYLE_GUIDE.md §6 keeps every combo for one subject together, so a reader checking one trait or token finds all of its rules in one place.`,
            );
            break;
          }
          seen.add(subject);
        }
      }
      for (let i = 1; i < combos.length; i++) {
        const prev = combos[i - 1];
        const next = combos[i];
        const sameSubject = String(prev && prev.subject) === String(next && next.subject);
        if (sameSubject && levelRank(prev.level) > levelRank(next.level)) {
          emit(
            `${at}/combos`,
            `two combos share subject "${prev.subject}" but run level: ${prev.level} before level: ${next.level} — STYLE_GUIDE.md §6 orders them ${LEVEL.values.join(", ")} within one subject.`,
          );
          break;
        }
      }
    }
  },
  // STYLE_GUIDE.md's "Base documents" order - only applies to a base document (has
  // schemaVersion); a standalone entry file has no document-level fields to order.
  "document-field-order": (doc, emit) => {
    if (typeof doc.schemaVersion === "undefined") return;
    const actual = Object.keys(doc).filter((k) => DOCUMENT_FIELD_ORDER.includes(k));
    const inversion = firstInversion(actual, (k) => DOCUMENT_FIELD_ORDER.indexOf(k));
    if (inversion) {
      emit(
        "",
        `document has \`${inversion[0]}\` before \`${inversion[1]}\` — STYLE_GUIDE.md says match the spec's own declared order, which for a base document (base.schema.yaml) is [${DOCUMENT_FIELD_ORDER.join(", ")}]. Actual order here: [${actual.join(", ")}].`,
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main() {
  // `--self-check` runs activeRules()'s catalog/implementation drift gate and stops. CI runs
  // the findings pass under continue-on-error (they're advisory), which used to swallow this
  // gate too - a catalog rule with no implementation only failed the build indirectly, via the
  // prose-range guards. This mode is a separate, blocking step.
  const selfCheckOnly = process.argv.includes("--self-check");
  const rules = activeRules();
  if (selfCheckOnly) {
    console.log(
      `✓ All ${rules.length} advisory rule(s) in schema/conformance-rules.yaml have an ` +
        `implementation in scripts/validate/lint-docs.js, and vice versa.`,
    );
    return;
  }

  const args = process.argv.slice(2).filter((a) => a !== "--self-check");
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

  console.log("\nDSDS Doc Lint (warnings only — never fails the build)");
  console.log(`  ${rules.length} rule(s) from schema/conformance-rules.yaml: ${rules.map((r) => r.id).join(", ")}\n`);

  let totalFindings = 0;
  let cleanFiles = 0;

  for (const target of targets) {
    let doc;
    try {
      doc = loadYaml(target);
    } catch {
      continue; // not this tool's job - validate.js reports parse errors
    }
    const rel = path.relative(process.cwd(), target);
    const findings = [];
    for (const rule of rules) {
      if (rule.scope !== "document") continue;
      rule.check(doc, (p, message) => findings.push({ id: rule.id, rule: rule.name, path: p, message }));
    }
    for (const entry of entriesIn(doc)) {
      for (const rule of rules) {
        if (rule.scope === "document") continue;
        rule.check(entry, (p, message) => findings.push({ id: rule.id, rule: rule.name, path: p, message }));
      }
    }
    if (findings.length === 0) {
      cleanFiles++;
      continue;
    }
    console.log(`  ${rel}`);
    for (const f of findings) {
      console.log(`    ⚠ [${f.id} ${f.rule}] ${f.path}: ${f.message}`);
      totalFindings++;
    }
    console.log("");
  }

  console.log(`  ${targets.length} file(s) linted: ${cleanFiles} clean, ${totalFindings} warning(s).\n`);
}

main();
