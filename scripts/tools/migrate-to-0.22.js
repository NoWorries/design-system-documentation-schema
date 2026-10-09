#!/usr/bin/env node
/**
 * Migrates DSDS 0.21.x documents to 0.22.0. Rewrites files in place unless --dry-run is passed.
 *
 * What it changes:
 *
 *   - `purpose` (on an entry, a trait, or a trait value) and `metadata.context` (on an entry
 *     or a shared entry) are folded into `description`, which is now the one place that says
 *     why something exists. The text is appended, not rewritten, and every fold is reported so
 *     a person can tighten the result.
 *   - A section's `metadata` is gone. Its contents move, unchanged, to the section's
 *     `$extensions["com.dsds.migration"].metadata`, so nothing is lost.
 *   - `metadata.origin.author` has three values now. `ai-assisted` and `machine-assisted`
 *     become `assisted`; `ai-generated` and `machine-generated` become `generated`. Each change
 *     is reported, since the AI-versus-script distinction now belongs in `origin.note`.
 *   - `rel: composes`, `depends-on` and `implements` become `rel: uses`.
 *   - `rel: part-of` and `rel: replaces` pointed the other way, so they're flipped: `button
 *     part-of button-group` becomes `button-group uses button`, written on the group, and
 *     `new replaces old` becomes `old replaced-by new`, written on the old one. A flip can
 *     edit another file, so pass every file of a project in one run. A flip that would only
 *     duplicate a ref the target already has just removes the source side.
 *   - `schemaVersion` and any versioned `$schema` URL move to 0.22.0.
 *
 * Then, a second pass over that result, for 0.22.0's pointer fields:
 *
 *   - `rel` values merge: `test`, `lint-rule` and `agent-test` become `checked-by` (the old value
 *     moves to `role`); `external-link` becomes `cites` in `evidence` and `relates-to`
 *     elsewhere; `storybook` becomes `demo`; `package` becomes `source`; `see-also`,
 *     `pairs-with` and `excludes` become `relates-to`.
 *   - A pointer in a field named for its kind (`extends`, `alternatives`, `evidence`, `checks`,
 *     `refines`, `specs`) loses its `rel`: the field says it.
 *   - `related` is split: `alternative-to` pointers go to `alternatives`, a guideline's
 *     `refines` pointers are written on the agent rule instead (as `refines`, pointing back),
 *     and anything else goes to the field or `refs` its new rel belongs in.
 *   - A pointer in `refs` whose kind has a field on that object moves into the field: `uses`
 *     to `uses`, and `replaced-by` into the deprecated `status`, as `replacedBy`.
 *   - A checklist step's `checks` moves onto the guideline it verifies, pointing back at the step.
 *   - `rel: file` is for DSDS documents only. One pointing at a code file, or at a .json file
 *     that isn't a DSDS document (a DTCG token file), becomes `rel: source`, and a `role: source`
 *     that only restated it is dropped. One it can't tell (no extension, or a .json file it
 *     can't read) is reported.
 *   - A token's or theme's `source`, and a component's `sourceFiles[].file`, lose their `rel`:
 *     the field says it.
 *
 * Like migrate-to-0.21.js, this edits the original text rather than re-serialising the
 * document, so comments, blank lines and line wrapping outside the changed fields survive.
 * The `yaml` package is used only to find where each field sits in the file.
 *
 * A case it can't edit safely (a removed field that opens a list item, a section that already
 * has an inline or `com.dsds.migration` extension, a flip whose target isn't in the files given,
 * or a flipped ref carrying a `role`) is left alone and reported. A ref left with its old `rel`
 * fails validation, so nothing slips through silently. Run `npm run validate`
 * afterward: a leftover field fails validation on every kind except the open `kind: entry`
 * base and custom kinds, which accept extra fields.
 *
 * Usage: node scripts/tools/migrate-to-0.22.js <files-or-dirs…> [--dry-run]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const TARGET_VERSION = "0.22.0";
const MIGRATION_NS = "com.dsds.migration";
const AUTHOR_MAP = {
  "ai-assisted": "assisted",
  "machine-assisted": "assisted",
  "ai-generated": "generated",
  "machine-generated": "generated",
};
const RENAMED_RELS = { composes: "uses", "depends-on": "uses", implements: "uses" };
// Written on the other end now: { old rel -> new rel, written on the old target }.
const FLIPPED_RELS = { "part-of": "uses", replaces: "replaced-by" };
// A ref the target already has that says the same thing as a flip, once renamed.
const SAME_MEANING = { uses: new Set(["uses", "composes", "depends-on", "implements"]), "replaced-by": new Set(["replaced-by"]) };
// Fields that go before `refs` on an entry; a new `refs` is inserted after the last of these.
const BEFORE_REFS = ["kind", "id", "name", "description", "purpose", "metadata", "sections", "extends", "related"];

// A rewritten description stays on one line up to this width, then wraps as a folded block.
const MAX_LINE = 100;
const WRAP_AT = 80;

// ---------------------------------------------------------------------------
// Locating things in the source
// ---------------------------------------------------------------------------

function pairOf(map, key) {
  if (!YAML.isMap(map)) return null;
  return map.items.find((p) => YAML.isScalar(p.key) && p.key.value === key) || null;
}

function mapsIn(seqPair) {
  return seqPair && YAML.isSeq(seqPair.value) ? seqPair.value.items.filter((n) => YAML.isMap(n)) : [];
}

function scalarText(pair) {
  return pair && YAML.isScalar(pair.value) && typeof pair.value.value === "string" ? pair.value.value : null;
}

class Source {
  constructor(text) {
    this.lines = text.split("\n");
    this.starts = [];
    let at = 0;
    for (const line of this.lines) {
      this.starts.push(at);
      at += line.length + 1;
    }
    this.text = text;
    this.edits = []; // { from, to, lines } - replace lines[from..to] inclusive
    this.inline = []; // { start, end, text } - replace characters within one line
  }

  // Replaces a span inside one line, leaving the line count unchanged. Used for a `rel` value,
  // which can share its line with other refs in a flow list.
  substitute(node, text) {
    this.inline.push({ start: node.range[0], end: node.range[1], text });
  }

  // The same, for a character range rather than a node.
  substituteRange(start, end, text) {
    this.inline.push({ start, end, text });
  }

  lineOf(offset) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // The lines a key/value pair occupies, and what precedes the key on its first line
  // (indentation, or "- " when the key opens a list item).
  span(pair) {
    const keyStart = pair.key.range[0];
    const from = this.lineOf(keyStart);
    const valueEnd = pair.value && pair.value.range ? pair.value.range[1] : pair.key.range[1];
    const to = Math.max(from, this.lineOf(Math.max(keyStart, valueEnd - 1)));
    const col = keyStart - this.starts[from];
    return { from, to, col, prefix: this.lines[from].slice(0, col) };
  }

  replace(from, to, lines) {
    this.edits.push({ from, to, lines });
  }

  apply() {
    // Bottom-up, so earlier line numbers stay valid. At the same line, a replacement or
    // deletion goes before an insertion (to < from), so the insertion isn't the thing deleted.
    const isInsert = (e) => e.to < e.from;
    const sorted = [...this.edits].sort((a, b) => b.from - a.from || isInsert(a) - isInsert(b));
    for (let i = 1; i < sorted.length; i++) {
      const [later, earlier] = [sorted[i - 1], sorted[i]];
      if (!isInsert(earlier) && !isInsert(later) && earlier.to >= later.from) throw new Error("internal: overlapping edits");
    }
    const lines = [...this.lines];
    for (const { start, end, text } of [...this.inline].sort((a, b) => b.start - a.start)) {
      const line = this.lineOf(start);
      const col = start - this.starts[line];
      lines[line] = lines[line].slice(0, col) + text + lines[line].slice(col + (end - start));
    }
    for (const { from, to, lines: repl } of sorted) lines.splice(from, to - from + 1, ...repl);
    return lines.join("\n");
  }
}

const opensListItem = (prefix) => prefix.trim() !== "";

// ---------------------------------------------------------------------------
// Rendering a rewritten description
// ---------------------------------------------------------------------------

function joinWhy(parts) {
  let out = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    const multiline = out.includes("\n") || part.includes("\n");
    const ended = /[.!?:]["')\]]*$/.test(out) ? out : `${out}.`;
    out = `${ended}${multiline ? "\n\n" : " "}${part}`;
  }
  return out;
}

function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/ +/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function renderPair(key, text, prefix, col) {
  const inner = " ".repeat(col + 2);
  if (text.includes("\n")) {
    return [`${prefix}${key}: |-`, ...text.split("\n").map((l) => (l ? `${inner}${l}` : ""))];
  }
  const plain = YAML.stringify(text, { lineWidth: 0 }).trimEnd();
  if (!plain.includes("\n") && col + key.length + 2 + plain.length <= MAX_LINE) {
    return [`${prefix}${key}: ${plain}`];
  }
  return [`${prefix}${key}: >-`, ...wrap(text, Math.max(40, WRAP_AT - col - 2)).map((l) => `${inner}${l}`)];
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

// Every ref-shaped map ({rel, ...}) under `node`, with the list item it sits in. `$extensions`
// subtrees are vendor data and skipped.
function findRefMaps(node, seqPair, out, inFlow = false) {
  if (YAML.isMap(node)) {
    const relPair = pairOf(node, "rel");
    if (relPair && YAML.isScalar(relPair.value) && typeof relPair.value.value === "string") {
      out.push({ map: node, relPair, toPair: pairOf(node, "to"), seqPair, flow: inFlow || Boolean(node.flow) });
    }
    for (const pair of node.items) {
      if (YAML.isScalar(pair.key) && pair.key.value === "$extensions") continue;
      if (YAML.isSeq(pair.value)) {
        for (const item of pair.value.items) findRefMaps(item, pair, out, inFlow || Boolean(node.flow || pair.value.flow));
      } else {
        findRefMaps(pair.value, null, out, inFlow || Boolean(node.flow));
      }
    }
  }
}

function parseFile(filePath) {
  const text = fs.readFileSync(filePath, "utf-8");
  const label = path.relative(process.cwd(), filePath);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) return { label, skipped: `does not parse: ${doc.errors[0].message}` };
  const root = doc.contents;
  if (!YAML.isMap(root)) return { label, skipped: "not a YAML mapping" };
  const isBase = Boolean(pairOf(root, "schemaVersion"));
  const entities = isBase ? [...mapsIn(pairOf(root, "entries")), ...mapsIn(pairOf(root, "shared"))] : [root];
  const file = { path: filePath, label, text, root, entities, src: new Source(text), report: [], refsByEntity: new Map() };
  for (const entity of entities) {
    const refs = [];
    findRefMaps(entity, null, refs);
    file.refsByEntity.set(entity, refs);
  }
  return file;
}

function migrateFile(file, flips) {
  const { root, src, report, label, entities } = file;
  const note = (pair, msg) => report.push(`${label}:${src.lineOf(pair.key.range[0]) + 1}: ${msg}`);

  // Version fields.
  const versionPair = pairOf(root, "schemaVersion");
  if (versionPair && scalarText(versionPair) !== TARGET_VERSION) {
    const { from, to, prefix } = src.span(versionPair);
    src.replace(from, to, [`${prefix}schemaVersion: "${TARGET_VERSION}"`]);
  }
  const schemaPair = pairOf(root, "$schema");
  const schemaUrl = scalarText(schemaPair);
  if (schemaUrl && /\/v\d+\.\d+\.\d+\//.test(schemaUrl)) {
    const next = schemaUrl.replace(/\/v\d+\.\d+\.\d+\//, `/v${TARGET_VERSION}/`);
    if (next !== schemaUrl) {
      const { from, to, prefix } = src.span(schemaPair);
      src.replace(from, to, [`${prefix}$schema: ${next}`]);
    }
  }

  let folds = 0;
  let movedSections = 0;
  let authors = 0;

  // Folds each present "why" field into `owner`'s description, then removes it. `fields` is
  // a list of { pair, remove }: `remove` is what gets deleted (usually the pair itself, but the
  // whole `metadata` pair when `context` was its only field, so no empty `metadata:` is left).
  function foldInto(owner, fields, what) {
    const present = fields.filter((f) => f.pair);
    if (!present.length) return;
    const names = present.map((f) => `\`${f.pair.key.value}\``).join(" and ");
    for (const { pair } of present) {
      if (opensListItem(src.span(pair).prefix) || scalarText(pair) === null) {
        note(pair, `${names} on ${what} needs folding into \`description\` by hand (it opens a list item, or isn't plain text)`);
        return;
      }
    }
    const descPair = pairOf(owner, "description");
    if (descPair && scalarText(descPair) === null) {
      note(descPair, `${what} has a non-text \`description\`; fold ${names} into it by hand`);
      return;
    }
    const purpose = present.find((f) => f.pair === pairOf(owner, "purpose"));
    if (!descPair && !purpose) {
      note(present[0].pair, `${what} has no \`description\` to fold ${names} into; add one by hand`);
      return;
    }
    const combined = joinWhy([descPair ? scalarText(descPair) : "", ...present.map((f) => scalarText(f.pair))]);

    // With no description, `purpose`'s own line becomes it, in place.
    const target = descPair || purpose.pair;
    const { from, to, col, prefix } = src.span(target);
    src.replace(from, to, renderPair("description", combined, prefix, col));
    for (const field of present) {
      if (!descPair && field === purpose) continue;
      const span = src.span(field.remove);
      src.replace(span.from, span.to, []);
    }
    folds++;
    note(present[0].pair, `folded ${names} into ${what}'s \`description\` - reread it`);
  }

  for (const entity of entities) {
    const id = scalarText(pairOf(entity, "id")) || "(no id)";
    const metadata = pairOf(entity, "metadata");
    const metaMap = metadata && YAML.isMap(metadata.value) ? metadata.value : null;
    const contextPair = metaMap ? pairOf(metaMap, "context") : null;

    const purposePair = pairOf(entity, "purpose");
    foldInto(
      entity,
      [
        { pair: purposePair, remove: purposePair },
        { pair: contextPair, remove: contextPair && metaMap.items.length === 1 ? metadata : contextPair },
      ],
      `"${id}"`,
    );

    // origin.author
    const origin = metaMap ? pairOf(metaMap, "origin") : null;
    const authorPair = origin && YAML.isMap(origin.value) ? pairOf(origin.value, "author") : null;
    const author = scalarText(authorPair);
    if (author && AUTHOR_MAP[author]) {
      const { from, to, prefix } = src.span(authorPair);
      src.replace(from, to, [`${prefix}author: ${AUTHOR_MAP[author]}`]);
      authors++;
      note(authorPair, `"${id}" origin.author: ${author} -> ${AUTHOR_MAP[author]}. If it matters whether this was an AI model or a script, say so in origin.note`);
    }

    // Traits and trait values.
    for (const trait of mapsIn(pairOf(entity, "traits"))) {
      const traitId = scalarText(pairOf(trait, "id")) || "(no id)";
      const traitPurpose = pairOf(trait, "purpose");
      foldInto(trait, [{ pair: traitPurpose, remove: traitPurpose }], `trait "${id}.${traitId}"`);
      for (const value of mapsIn(pairOf(trait, "values"))) {
        const valueId = scalarText(pairOf(value, "id")) || "(no id)";
        const valuePurpose = pairOf(value, "purpose");
        foldInto(value, [{ pair: valuePurpose, remove: valuePurpose }], `trait value "${id}.${traitId}.${valueId}"`);
      }
    }

    // `rel` renames, and flips queued for later (they can touch another file).
    for (const ref of file.refsByEntity.get(entity)) {
      const rel = ref.relPair.value.value;
      if (RENAMED_RELS[rel]) {
        src.substitute(ref.relPair.value, RENAMED_RELS[rel]);
        file.renamed = (file.renamed || 0) + 1;
      } else if (FLIPPED_RELS[rel]) {
        flips.push({ file, entity, sourceId: id, ref, oldRel: rel, newRel: FLIPPED_RELS[rel], note: (msg) => note(ref.relPair, msg) });
      }
    }

    // Section metadata.
    for (const section of mapsIn(pairOf(entity, "sections"))) {
      const sectionMeta = pairOf(section, "metadata");
      if (!sectionMeta) continue;
      const span = src.span(sectionMeta);
      if (opensListItem(span.prefix)) {
        note(sectionMeta, `a section's \`metadata\` opens its list item; move it under \`$extensions.${MIGRATION_NS}\` by hand`);
        continue;
      }
      const pad = (n) => " ".repeat(n);
      const body = src.lines.slice(span.from, span.to + 1);
      const shifted = (by) => [body[0].replace(/^ */, pad(span.col + by)), ...body.slice(1).map((l) => (l.trim() ? pad(by) + l : l))];
      const extPair = pairOf(section, "$extensions");
      if (!extPair) {
        src.replace(span.from, span.to, [`${span.prefix}$extensions:`, `${pad(span.col + 2)}${MIGRATION_NS}:`, ...shifted(4)]);
      } else if (YAML.isMap(extPair.value) && !extPair.value.flow && extPair.value.items.length && !pairOf(extPair.value, MIGRATION_NS)) {
        const ext = src.span(extPair);
        const extCol = src.span(extPair.value.items[0]).col;
        src.replace(span.from, span.to, []);
        src.replace(ext.to + 1, ext.to, [`${pad(extCol)}${MIGRATION_NS}:`, ...shifted(extCol - span.col + 2)]);
      } else {
        note(sectionMeta, `section's \`$extensions\` is inline or already has \`${MIGRATION_NS}\`; move its \`metadata\` by hand`);
        continue;
      }
      movedSections++;
      note(sectionMeta, `"${id}" section metadata moved to the section's $extensions.${MIGRATION_NS}.metadata`);
    }
  }

  // Comments that still talk about a removed field.
  src.lines.forEach((line, i) => {
    const hash = line.indexOf("#");
    if (hash !== -1 && /^\s*#/.test(line) && /`purpose`|\bpurpose:|metadata\.context|\b(ai|machine)-(assisted|generated)\b|\b(composes|depends-on|part-of|implements|replaces)\b/.test(line.slice(hash))) {
      report.push(`${label}:${i + 1}: comment mentions a field or value 0.22.0 removed - reword or delete`);
    }
  });

  file.stats = { folds, movedSections, authors };
}

// ---------------------------------------------------------------------------
// Flips: `part-of` and `replaces` move to the other end
// ---------------------------------------------------------------------------

// Where an entry id is defined across every file in the run. Prefers the same file, then the
// same directory; anything still ambiguous is reported instead of guessed.
function findTarget(index, id, fromFile) {
  const candidates = index.get(id) || [];
  const same = candidates.filter((c) => c.file === fromFile);
  if (same.length) return { target: same[0] };
  const sameDir = candidates.filter((c) => path.dirname(c.file.path) === path.dirname(fromFile.path));
  if (sameDir.length === 1) return { target: sameDir[0] };
  if (candidates.length === 1) return { target: candidates[0] };
  return { reason: candidates.length ? `"${id}" is defined in ${candidates.length} files given` : `"${id}" isn't in the files given` };
}

const dashCol = (src, item) => {
  const line = src.lineOf(item.range[0]);
  const col = item.range[0] - src.starts[line];
  return src.lines[line].lastIndexOf("-", col - 1);
};

function applyFlips(files, flips) {
  const index = new Map();
  for (const file of files) {
    for (const entity of file.entities) {
      const id = scalarText(pairOf(entity, "id"));
      if (!id) continue;
      if (!index.has(id)) index.set(id, []);
      index.get(id).push({ file, entity, id });
    }
  }

  const removals = new Map(); // seqPair -> { file, items: Set }
  const additions = new Map(); // target entity -> { file, refs: [{ to, rel, note }] }

  for (const flip of flips) {
    const { ref, sourceId, oldRel, newRel } = flip;
    const to = ref.toPair ? scalarText(ref.toPair) : null;
    const extra = ref.map.items.map((p) => p.key.value).filter((k) => !["to", "rel", "note"].includes(k));
    let why = null;
    if (!to || to.includes("#") || to.includes("://")) why = "it doesn't point at a whole entry";
    else if (ref.flow || !ref.seqPair || YAML.isSeq(ref.seqPair.value) === false || ref.seqPair.value.flow) why = "it's written inline (flow style)";
    else if (extra.length) why = `it carries ${extra.map((k) => `\`${k}\``).join(", ")}, which describes the other end and may not hold after the flip`;
    let target;
    if (!why) {
      const found = findTarget(index, to, flip.file);
      if (found.reason) why = found.reason;
      else target = found.target;
    }
    if (why) {
      flip.note(`\`${sourceId}\` rel: ${oldRel} -> \`${to}\` needs flipping by hand (${why}): write \`{to: ${sourceId}, rel: ${newRel}}\` on \`${to}\` and remove this ref`);
      continue;
    }
    if (target.entity === flip.entity) {
      flip.note(`\`${sourceId}\` rel: ${oldRel} points at itself; remove it by hand`);
      continue;
    }

    // Remove the source side.
    if (!removals.has(ref.seqPair)) removals.set(ref.seqPair, { file: flip.file, items: new Set() });
    removals.get(ref.seqPair).items.add(ref.map);

    // Add the target side, unless it already says the same thing.
    const noteText = ref.map.items.find((p) => p.key.value === "note");
    const existing = target.file.refsByEntity
      .get(target.entity)
      .find(
        (r) =>
          r.seqPair &&
          target.entity.items.includes(r.seqPair) && // the entry's own refs/related/extends, not an item's
          r.toPair &&
          scalarText(r.toPair) === sourceId &&
          SAME_MEANING[newRel].has(r.relPair.value.value),
      );
    const where = target.file === flip.file ? "" : ` in ${target.file.label}`;
    if (existing) {
      flip.note(`removed \`${sourceId}\` rel: ${oldRel} -> \`${to}\`; \`${to}\`${where} already points back at it${noteText ? ` (this ref's note was dropped: "${scalarText(noteText)}")` : ""}`);
      continue;
    }
    if (!additions.has(target.entity)) additions.set(target.entity, { file: target.file, refs: [] });
    const adding = additions.get(target.entity).refs;
    if (adding.some((r) => r.to === sourceId && r.rel === newRel)) continue;
    adding.push({ to: sourceId, rel: newRel, note: noteText ? scalarText(noteText) : null });
    flip.note(`moved \`${sourceId}\` rel: ${oldRel} -> \`${to}\` to \`${to}\`${where} as \`{to: ${sourceId}, rel: ${newRel}}\`${where ? " - check you own that file" : ""}`);
  }

  // Additions first: a target's own `refs` may be emptied by a removal, and then the new refs
  // replace it rather than being inserted into a list that's about to disappear.
  const replacedSeqs = new Set();
  for (const [entity, { file, refs }] of additions) {
    const { src } = file;
    const refLines = (dash) =>
      refs.flatMap((r) => [
        `${" ".repeat(dash)}- to: ${r.to}`,
        `${" ".repeat(dash + 2)}rel: ${r.rel}`,
        ...(r.note && !r.note.includes("\n") ? [`${" ".repeat(dash + 2)}note: ${YAML.stringify(r.note, { lineWidth: 0 }).trimEnd()}`] : []),
      ]);
    const refsPair = pairOf(entity, "refs");
    if (refsPair && YAML.isSeq(refsPair.value) && !refsPair.value.flow && refsPair.value.items.length) {
      const items = refsPair.value.items;
      const removal = removals.get(refsPair);
      const dash = dashCol(src, items[0]);
      if (removal && removal.items.size === items.length) {
        const span = src.span(refsPair);
        src.replace(span.from, span.to, [`${span.prefix}refs:`, ...refLines(dash)]);
        replacedSeqs.add(refsPair);
      } else {
        const last = src.lineOf(items[items.length - 1].range[1] - 1);
        src.replace(last + 1, last, refLines(dash));
      }
    } else if (refsPair) {
      const id = scalarText(pairOf(entity, "id"));
      file.report.push(`${file.label}:${src.lineOf(refsPair.key.range[0]) + 1}: "${id}" refs is inline; add ${refs.map((r) => `{to: ${r.to}, rel: ${r.rel}}`).join(", ")} by hand`);
    } else {
      const before = entity.items.filter((p) => BEFORE_REFS.includes(p.key.value));
      const anchor = before.length ? before[before.length - 1] : entity.items[entity.items.length - 1];
      const col = src.span(entity.items[1] || entity.items[0]).col;
      const at = src.lineOf(anchor.value && anchor.value.range ? anchor.value.range[1] - 1 : anchor.key.range[1]) + 1;
      const blank = at < src.lines.length && src.lines[at].trim() === "" && col === 0 ? [""] : [];
      src.replace(at, at - 1, [...blank, `${" ".repeat(col)}refs:`, ...refLines(col + 2)]);
    }
  }

  for (const [seqPair, { file, items }] of removals) {
    if (replacedSeqs.has(seqPair)) continue;
    const { src } = file;
    if (items.size === seqPair.value.items.length) {
      const span = src.span(seqPair);
      src.replace(span.from, span.to, []);
      continue;
    }
    for (const item of items) {
      const from = src.lineOf(item.range[0]);
      const to = src.lineOf(item.range[1] - 1);
      src.replace(from, to, []);
    }
  }
}

// ---------------------------------------------------------------------------
// Second pass: pointer fields
// ---------------------------------------------------------------------------

const { deriveId } = require("../lib");

const FIELD_RELS = { uses: "uses", replacedBy: "replaced-by", extends: "extends", alternatives: "alternative-to", evidence: "cites", checks: "checked-by", specs: "contract", refines: "refines" };
const CHECK_KINDS = new Set(["test", "lint-rule", "agent-test"]);
// `replaced-by` moves into the deprecated `status`, next to `deprecationNotice`, not a sibling field.
const STATUS_FIELD = "status.replacedBy";
const MERGED_RELS = { storybook: "demo", package: "source", "see-also": "relates-to", "pairs-with": "relates-to", excludes: "relates-to" };
// Kinds of pointer that go in a field of their own, per object, as old-or-new rel -> field.
const ENTRY_FIELDS = { uses: "uses", extends: "extends", "alternative-to": "alternatives", "replaced-by": STATUS_FIELD };
const ITEM_FIELDS = { uses: "uses" };
const TRAIT_FIELDS = { "replaced-by": STATUS_FIELD };
const COMPONENT_FIELDS = { ...ENTRY_FIELDS, contract: "specs" };
const GUIDELINE_FIELDS = {
  uses: "uses",
  "alternative-to": "alternatives",
  cites: "evidence",
  "checked-by": "checks",
  test: "checks",
  "lint-rule": "checks",
  "agent-test": "checks",
  refines: "refines",
};

// Single-pointer fields that imply `rel: source`. A `file` or `package` rel there was the same
// thing written the old way.
const SOURCE_FIELDS = new Set(["source", "file"]);

// Whether a `rel: file` href is a DSDS document ("document"), a code or token file ("source"),
// or can't be told ("unknown"). A .json file is read: a DSDS document has `schemaVersion`, or
// `kind` and `id`.
function fileRefKind(href, fromPath) {
  if (typeof href !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(href)) return "unknown";
  const file = href.split("#")[0].split("?")[0];
  const ext = path.extname(file).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") return "document";
  if (!ext) return "unknown";
  if (ext !== ".json") return "source";
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fromPath), file), "utf-8"));
    return data && typeof data === "object" && (data.schemaVersion !== undefined || (data.kind && data.id)) ? "document" : "source";
  } catch (e) {
    return "unknown";
  }
}

// The rel a pointer gets in 0.22.0, given the field it sits in (null: `refs` or a plain list).
function newRel(rel, field) {
  if (SOURCE_FIELDS.has(field) && (rel === "file" || rel === "package")) return "source";
  if (CHECK_KINDS.has(rel)) return "checked-by";
  if (rel === "external-link") return field === "evidence" ? "cites" : "relates-to";
  return MERGED_RELS[rel] || rel;
}

// One pointer's lines, re-indented so its dash sits at `dash`, with its `rel` line removed - or
// turned into `role: <kind>` when an old check kind would otherwise be lost.
function pointerLines(src, item, dash, relPair, keepKindAsRole, renameRelTo = null) {
  const from = src.lineOf(item.range[0]);
  const to = src.lineOf(item.range[1] - 1);
  const dashLine = (() => {
    let l = from;
    while (l >= 0 && !/^\s*-(\s|$)/.test(src.lines[l])) l--;
    return l;
  })();
  const oldDash = src.lines[dashLine].indexOf("-");
  // Comments directly above the dash belong to this pointer and move with it.
  const lead = leadingComments(src, dashLine);
  let lines = [...src.lines.slice(lead, dashLine).map((l) => " ".repeat(oldDash) + l.trimStart()), ...src.lines.slice(dashLine, to + 1)];
  const relLine = src.lineOf(relPair.key.range[0]) - dashLine + (dashLine - lead);
  const kind = scalarText(relPair);
  if (renameRelTo) {
    lines[relLine] = lines[relLine].replace(/rel:\s*\S+/, `rel: ${renameRelTo}`);
  } else if (keepKindAsRole) {
    lines[relLine] = lines[relLine].replace(/rel:\s*\S+/, `role: ${kind}`);
  } else if (relLine === dashLine - lead) {
    // `- rel: x` opened the item: the next field takes the dash.
    const next = lines.findIndex((l, i) => i > relLine && l.trim() && !/^\s*#/.test(l));
    if (next === -1) return null;
    lines[next] = lines[next].slice(0, oldDash) + "- " + lines[next].slice(oldDash + 2);
    lines = lines.filter((_, i) => i !== relLine);
  } else {
    lines = lines.filter((_, i) => i !== relLine);
  }
  const shift = dash - oldDash;
  return lines.map((l) => (!l.trim() ? l : shift >= 0 ? " ".repeat(shift) + l : l.slice(Math.min(-shift, l.length - l.trimStart().length))));
}

// The first of the comment lines directly above `line` (or `line` itself when there are none).
function leadingComments(src, line) {
  let first = line;
  while (first > 0 && /^\s*#/.test(src.lines[first - 1])) first--;
  return first;
}

// Adds pointer lines to `key` on `map`: after the list's last item, or as a new key at the end.
function appendToField(src, map, key, build) {
  const pair = pairOf(map, key);
  if (pair && YAML.isSeq(pair.value) && !pair.value.flow && pair.value.items.length) {
    const items = pair.value.items;
    const last = src.lineOf(items[items.length - 1].range[1] - 1);
    src.replace(last + 1, last, build(dashCol(src, items[0])));
    // So removeItems keeps this key even if every original item moves out.
    if (!src.appendedTo) src.appendedTo = new Set();
    src.appendedTo.add(pair.value);
    return true;
  }
  if (pair) return false; // inline, or empty: by hand
  // A key this pass already created on this map: add to it rather than writing the key twice.
  if (!src.newKeys) src.newKeys = new Map();
  if (!src.newKeys.has(map)) src.newKeys.set(map, new Map());
  const created = src.newKeys.get(map).get(key);
  if (created) {
    created.edit.lines.push(...build(created.col + 2));
    return true;
  }
  const first = map.items[0];
  const col = src.lineOf(first.key.range[0]) === src.lineOf(map.range[0]) && src.lines[src.lineOf(first.key.range[0])].trim().startsWith("-")
    ? src.lines[src.lineOf(first.key.range[0])].indexOf("-") + 2
    : src.span(first).col;
  const last = map.items[map.items.length - 1];
  const end = src.lineOf((last.value && last.value.range ? last.value.range[1] : last.key.range[1]) - 1);
  src.replace(end + 1, end, [`${" ".repeat(col)}${key}:`, ...build(col + 2)]);
  src.newKeys.get(map).set(key, { edit: src.edits[src.edits.length - 1], col });
  return true;
}

// Removes one list item's lines, with the comments directly above it, or the whole `key:` pair
// when every item goes. Returns any comment that would be lost and didn't belong to an item,
// so the caller can report it.
function removeItems(src, seqPair, items) {
  const dashOf = (item) => {
    let from = src.lineOf(item.range[0]);
    while (from > 0 && !/^\s*-(\s|$)/.test(src.lines[from])) from--;
    return from;
  };
  if (items.length === seqPair.value.items.length && !(src.appendedTo && src.appendedTo.has(seqPair.value))) {
    const span = src.span(seqPair);
    const owned = new Set();
    for (const item of items) for (let l = leadingComments(src, dashOf(item)); l <= src.lineOf(item.range[1] - 1); l++) owned.add(l);
    const lost = [];
    for (let l = span.from; l <= span.to; l++) if (/^\s*#/.test(src.lines[l]) && !owned.has(l)) lost.push(src.lines[l].trim());
    src.replace(span.from, span.to, []);
    return lost;
  }
  for (const item of items) {
    const from = dashOf(item);
    src.replace(leadingComments(src, from), src.lineOf(item.range[1] - 1), []);
  }
  return [];
}

function pointerFieldsPass(files) {
  // Guideline items by `entry#address`, across every file, for flipping step checks.
  const guidelines = new Map();
  const parsed = files.map((file) => {
    const doc = YAML.parseDocument(file.out);
    const src = new Source(file.out);
    const root = doc.contents;
    const isBase = Boolean(pairOf(root, "schemaVersion")) || (!pairOf(root, "kind") && (pairOf(root, "entries") || pairOf(root, "shared")));
    const entities = isBase ? [...mapsIn(pairOf(root, "entries")), ...mapsIn(pairOf(root, "shared"))] : [root];
    const p = { file, doc, src, entities, report: [] };
    for (const entity of entities) {
      const id = scalarText(pairOf(entity, "id"));
      for (const section of mapsIn(pairOf(entity, "sections"))) {
        if (scalarText(pairOf(section, "kind")) !== "guidelines") continue;
        for (const item of mapsIn(pairOf(section, "items"))) {
          const address = scalarText(pairOf(item, "id")) || deriveId(scalarText(pairOf(item, "statement")));
          if (id && address && !guidelines.has(`${id}#${address}`)) guidelines.set(`${id}#${address}`, { p, item });
        }
      }
    }
    return p;
  });

  for (const p of parsed) {
    const { src, entities, file } = p;
    const note = (node, msg) => p.report.push(`${file.label}:${src.lineOf(node.range[0]) + 1}: ${msg}`);
    const handled = new Set(); // ref maps already moved or rewritten

    // Empties a retired `related` list on `owner` into the place each pointer belongs in 0.22.0:
    // `alternative-to` to `alternatives`; `refines` (on a guideline) handled by the caller;
    // a kind with its own field to that field; anything else to `refs`, with its new rel.
    // `toRefines` is a callback for `refines` pointers, or null when there are none to expect.
    const splitRelated = (owner, fields, label, toRefines) => {
      const related = pairOf(owner, "related");
      if (!related) return;
      if (!YAML.isSeq(related.value) || related.value.flow) {
        note(related.key, `${label} \`related\` is written inline; split it by hand into \`alternatives\` and \`refs\``);
        return;
      }
      const groups = new Map(); // destination -> [{ item, relPair, keepRel }]
      for (const item of related.value.items) {
        if (!YAML.isMap(item)) continue;
        const relPair = pairOf(item, "rel");
        const rel = relPair ? scalarText(relPair) : null;
        if (!rel) {
          note(item, `${label} \`related\` has a pointer with no rel; move it by hand`);
          return;
        }
        if (rel === "refines" && toRefines) {
          toRefines(item);
          continue;
        }
        const next = newRel(rel, null);
        const field = next === "alternative-to" ? "alternatives" : fields[next] || fields[rel];
        const dest = field || "refs";
        if (!groups.has(dest)) groups.set(dest, []);
        groups.get(dest).push({ item, relPair, keepRel: !field, next });
      }
      for (const [dest, entries] of groups) {
        const ok = appendToField(src, owner, dest, (dash) =>
          entries.flatMap(({ item, relPair, keepRel, next }) => pointerLines(src, item, dash, relPair, false, keepRel ? next : null) || []),
        );
        if (!ok) {
          note(related.key, `${label}: couldn't move \`related\` pointers into \`${dest}\` (it's written inline); do it by hand`);
          return;
        }
        note(entries[0].item, `${label}: moved ${entries.length} pointer(s) from \`related\` to \`${dest}\``);
      }
      for (const item of related.value.items) handled.add(item);
      const span = src.span(related);
      if (opensListItem(span.prefix)) note(related.key, `${label} \`related\` opens its list item; delete it by hand`);
      else src.replace(span.from, span.to, []);
    };

    for (const entity of entities) {
      const id = scalarText(pairOf(entity, "id")) || "(no id)";
      const kind = scalarText(pairOf(entity, "kind"));

      // `related` on an entry: `alternative-to` pointers go to `alternatives`, and everything
      // else to the field or `refs` its 0.22.0 rel belongs in.
      splitRelated(entity, kind === "component" ? COMPONENT_FIELDS : ENTRY_FIELDS, `"${id}"`, null);

      const moveIntoStatus = (holder, entries, label) => {
        const statusPair = holder && pairOf(holder, "status");
        const status = statusPair && statusPair.value;
        const byHand = (why) => {
          note(entries[0].item, `${label} has replaced-by ref(s) in \`refs\`, but ${why}; move them into its \`status.replacedBy\` by hand, without their rel`);
          return false;
        };
        if (!YAML.isMap(status)) return byHand(status ? "its status is a per-platform list - pick the platform" : "it has no status");
        if (scalarText(pairOf(status, "status")) !== "deprecated") return byHand("its status isn't deprecated");
        if (pairOf(status, "replacedBy")) return byHand("its status already has a replacedBy");
        if (status.flow) {
          const plain = entries.map(({ item }) => {
            const out = {};
            for (const pair of item.items) if (YAML.isScalar(pair.key) && pair.key.value !== "rel") out[pair.key.value] = pair.value && pair.value.toJSON ? pair.value.toJSON() : pair.value;
            return out;
          });
          const close = status.range[1] - 1;
          if (src.text[close] !== "}") return byHand("its inline status couldn't be edited safely");
          const flow = YAML.stringify(plain, { collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 }).trim();
          src.substituteRange(close, close, `, replacedBy: ${flow}`);
          return true;
        }
        return appendToField(src, status, "replacedBy", (dash) =>
          entries.flatMap(({ item, relPair }) => pointerLines(src, item, dash, relPair, false) || []),
        ) || byHand("its status couldn't be edited safely");
      };

      // `statusHolder` is the map whose `status` a `replaced-by` moves into: an entry's
      // `metadata`, or the trait or trait value itself.
      const moveFrom = (owner, fields, label, statusHolder = owner) => {
        const refsPair = pairOf(owner, "refs");
        if (!refsPair || !YAML.isSeq(refsPair.value)) return;
        const moving = new Map(); // field -> [items]
        for (const item of refsPair.value.items) {
          if (!YAML.isMap(item)) continue;
          const relPair = pairOf(item, "rel");
          const field = relPair && fields[scalarText(relPair)];
          if (!field) continue;
          if (refsPair.value.flow || item.flow) {
            note(item, `${label} has a rel: ${scalarText(relPair)} ref written inline in \`refs\`; move it to \`${field}\` by hand, without its rel`);
            continue;
          }
          if (!moving.has(field)) moving.set(field, []);
          moving.get(field).push({ item, relPair });
        }
        const allItems = [];
        for (const [field, entries] of moving) {
          if (field === STATUS_FIELD) {
            if (moveIntoStatus(statusHolder, entries, label)) {
              for (const e of entries) {
                handled.add(e.item);
                allItems.push(e.item);
              }
              note(entries[0].item, `${label}: moved ${entries.length} replaced-by ref(s) from \`refs\` into its deprecated \`status\`, next to \`deprecationNotice\``);
            }
            continue;
          }
          const ok = appendToField(src, owner, field, (dash) =>
            entries.flatMap(({ item, relPair }) => pointerLines(src, item, dash, relPair, CHECK_KINDS.has(scalarText(relPair)) && !pairOf(item, "role")) || []),
          );
          if (!ok) {
            note(owner.items[0].key, `${label}'s \`${field}\` is written inline; move its rel: ${entries.map((e) => scalarText(e.relPair)).join(", ")} refs there by hand`);
            continue;
          }
          for (const e of entries) {
            handled.add(e.item);
            allItems.push(e.item);
            if (CHECK_KINDS.has(scalarText(e.relPair)) && pairOf(e.item, "role")) {
              note(e.item, `${label}: a rel: ${scalarText(e.relPair)} check moved to \`checks\`, and its role was kept; add "${scalarText(e.relPair)}" to the role if the kind of check matters`);
            }
          }
          note(entries[0].item, `${label}: moved ${entries.length} ref(s) from \`refs\` to \`${field}\``);
        }
        if (allItems.length) {
          const lost = removeItems(src, refsPair, allItems);
          if (lost.length) note(refsPair.key, `${label}: \`refs\` emptied; these comments in it had nowhere to go, so re-add them where they belong: ${lost.join(" | ")}`);
        }
      };
      const metadataMap = pairOf(entity, "metadata") && pairOf(entity, "metadata").value;
      if (kind) moveFrom(entity, kind === "component" ? COMPONENT_FIELDS : ENTRY_FIELDS, `"${id}"`, YAML.isMap(metadataMap) ? metadataMap : null);
      for (const trait of mapsIn(pairOf(entity, "traits"))) {
        const traitId = scalarText(pairOf(trait, "id"));
        moveFrom(trait, TRAIT_FIELDS, `"${id}" trait "${traitId}"`);
        for (const value of mapsIn(pairOf(trait, "values"))) {
          moveFrom(value, TRAIT_FIELDS, `"${id}" trait value "${traitId}.${scalarText(pairOf(value, "id"))}"`);
        }
      }

      for (const section of mapsIn(pairOf(entity, "sections"))) {
        const sectionKind = scalarText(pairOf(section, "kind"));
        for (const item of mapsIn(pairOf(section, "items"))) {
          if (sectionKind === "definitions" || sectionKind === "steps") moveFrom(item, ITEM_FIELDS, `"${id}" ${sectionKind} item`);
          if (sectionKind === "guidelines") {
            const address = scalarText(pairOf(item, "id")) || deriveId(scalarText(pairOf(item, "statement")));
            const unresolved = [];
            splitRelated(item, GUIDELINE_FIELDS, `"${id}" guideline`, (ref) => {
              // Written on the human rule, pointing at the agent rule. 0.22.0 writes it on the
              // agent rule instead, pointing back here.
              const to = scalarText(pairOf(ref, "to"));
              const target = to && guidelines.get(to);
              const line = (dash) => [`${" ".repeat(dash)}- to: ${id}#${address}`];
              if (!target || !address || !appendToField(target.p.src, target.item, "refines", line)) unresolved.push(to || "(no to)");
              else note(ref, `"${to}" now lists "${id}#${address}" in its \`refines\`${target.p !== p ? ` (in ${target.p.file.label})` : ""}`);
            });
            if (unresolved.length) {
              note(item, `"${id}" guideline: couldn't move refines pointer(s) to ${unresolved.join(", ")}; add \`refines: [{to: ${id}#${address || "<this rule's id>"}}]\` on each by hand`);
            }
            moveFrom(item, GUIDELINE_FIELDS, `"${id}" guideline`);
          }
          // A checklist step's `checks` moves onto the guideline it verifies.
          const stepChecks = sectionKind === "steps" ? pairOf(item, "checks") : null;
          if (!stepChecks) continue;
          const address = scalarText(pairOf(item, "id")) || deriveId(scalarText(pairOf(item, "title")));
          const targets = mapsIn(stepChecks);
          const unflipped = [];
          for (const check of targets) {
            const to = scalarText(pairOf(check, "to"));
            const target = to && guidelines.get(to);
            if (!target || !address) {
              unflipped.push(to || "(no to)");
              continue;
            }
            const line = (dash) => [`${" ".repeat(dash)}- to: ${id}#${address}`, `${" ".repeat(dash + 2)}role: checklist step`];
            if (!appendToField(target.p.src, target.item, "checks", line)) unflipped.push(to);
            else note(check, `step "${id}#${address}" now appears in "${to}"'s \`checks\`${target.p !== p ? ` (in ${target.p.file.label})` : ""}`);
          }
          if (unflipped.length) {
            note(stepChecks.key, `step "${id}#${address || "?"}" checks ${unflipped.join(", ")}, which isn't a guideline in the files given; add {to: ${id}#${address || "<step id>"}} to that guideline's \`checks\` by hand, then remove this`);
          } else {
            const span = src.span(stepChecks);
            if (opensListItem(span.prefix)) note(stepChecks.key, `step "${id}#${address}" \`checks\` opens its list item; remove it by hand`);
            else src.replace(span.from, span.to, []);
            for (const check of targets) handled.add(check);
          }
        }
      }
    }

    // Every remaining pointer: merge its rel, and drop it inside a named field.
    const visit = (node, field) => {
      if (YAML.isSeq(node)) {
        node.items.forEach((child) => visit(child, field));
        return;
      }
      if (!YAML.isMap(node)) return;
      const relPair = pairOf(node, "rel");
      if (relPair && field !== undefined && !handled.has(node) && typeof scalarText(relPair) === "string") {
        const rel = scalarText(relPair);
        const fieldRel = SOURCE_FIELDS.has(field) ? "source" : FIELD_RELS[field];
        if (field && fieldRel && newRel(rel, field) !== fieldRel) {
          note(relPair.key, `a rel: ${rel} pointer sits in \`${field}\`, which holds ${fieldRel} pointers; move it to \`refs\` as rel: ${newRel(rel, null)}`);
        } else if (field && fieldRel) {
          const kindToRole = field === "checks" && CHECK_KINDS.has(rel) && !pairOf(node, "role");
          if (kindToRole) {
            src.substituteRange(relPair.key.range[0], relPair.value.range[1], `role: ${rel}`);
          } else if (node.flow) {
            const i = node.items.indexOf(relPair);
            if (node.items.length === 1) note(node, `a pointer in \`${field}\` has only a rel; fix by hand`);
            else if (i > 0) src.substituteRange(node.items[i - 1].value.range[1], relPair.value.range[1], "");
            else src.substituteRange(relPair.key.range[0], node.items[1].key.range[0], "");
          } else {
            const span = src.span(relPair);
            if (opensListItem(span.prefix)) {
              const next = node.items[node.items.indexOf(relPair) + 1];
              if (!next) note(relPair.key, `a pointer in \`${field}\` has only a rel; fix by hand`);
              else {
                // The next field takes the list dash; comments in between stay above it.
                const nl = src.lineOf(next.key.range[0]);
                src.replace(span.from, nl, [...src.lines.slice(span.to + 1, nl), span.prefix + src.lines[nl].trimStart()]);
              }
            } else {
              src.replace(span.from, span.to, []);
            }
            if (CHECK_KINDS.has(rel) && pairOf(node, "role")) note(relPair.key, `a rel: ${rel} check keeps its role; add "${rel}" to the role if the kind of check matters`);
          }
        } else if (rel === "file") {
          const href = scalarText(pairOf(node, "href"));
          const kind = fileRefKind(href, file.path);
          if (kind === "source") {
            src.substitute(relPair.value, "source");
            const rolePair = pairOf(node, "role");
            if (rolePair && scalarText(rolePair) === "source") {
              const span = src.span(rolePair);
              if (node.flow || opensListItem(span.prefix)) note(rolePair.key, `"${href}" is rel: source now; its \`role: source\` says the same, so remove it`);
              else src.replace(span.from, span.to, []);
            }
          } else if (kind === "unknown") {
            note(relPair.key, `rel: file "${href}": rel: file is for DSDS documents only. If this is a code or token file, make it rel: source`);
          }
        } else {
          const next = newRel(rel, field);
          if (next !== rel) src.substitute(relPair.value, next);
        }
      }
      for (const pair of node.items) {
        const key = YAML.isScalar(pair.key) ? pair.key.value : undefined;
        if (key === "$extensions") continue;
        // `related` on an entry was renamed to `alternatives` above.
        const childField = YAML.isSeq(pair.value) ? (key === "related" ? undefined : key) : YAML.isMap(pair.value) && SOURCE_FIELDS.has(key) ? key : null;
        visit(pair.value, childField);
      }
    };
    for (const entity of entities) visit(entity, null);
    // A base document's own refs.
    const docRefs = pairOf(p.doc.contents, "refs");
    if (docRefs && !entities.includes(p.doc.contents)) visit(docRefs.value, "refs");

    // Comments that still use a retired rel.
    src.lines.forEach((line, i) => {
      if (/^\s*#/.test(line) && /\b(external-link|storybook|lint-rule|agent-test|see-also|pairs-with)\b|rel: (test|package|excludes)\b/.test(line)) {
        p.report.push(`${file.label}:${i + 1}: comment mentions a rel value 0.22.0 retired - reword or delete`);
      }
    });
  }

  return parsed.map((p) => ({ file: p.file, out: p.src.apply(), report: p.report }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function collect(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(target, e.name);
    if (e.isDirectory()) return collect(p);
    return /\.ya?ml$/.test(e.name) ? [p] : [];
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || !args.filter((a) => !a.startsWith("-")).length) {
    console.log("Usage: node scripts/tools/migrate-to-0.22.js <files-or-dirs…> [--dry-run]");
    console.log("Pass every file of a project in one run: flipping part-of and replaces can edit another file.");
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }
  const dryRun = args.includes("--dry-run");
  const paths = args.filter((a) => !a.startsWith("-")).flatMap(collect);

  const notes = [];
  const files = [];
  for (const filePath of paths) {
    const file = parseFile(filePath);
    if (file.skipped) notes.push(`${file.label}: skipped, ${file.skipped}`);
    else files.push(file);
  }
  const flips = [];
  for (const file of files) migrateFile(file, flips);
  applyFlips(files, flips);

  // Every output is produced and parsed before any file is written, so a failure leaves the
  // whole project untouched rather than half migrated.
  for (const file of files) {
    notes.push(...file.report);
    file.out = file.src.apply();
    const errors = YAML.parseDocument(file.out).errors;
    if (errors.length) {
      throw new Error(`${file.label}: the migrated text no longer parses (${errors[0].message}). Nothing was written.`);
    }
  }
  const outputs = [];
  for (const { file, out, report } of pointerFieldsPass(files)) {
    notes.push(...report);
    if (out === file.text) continue;
    const errors = YAML.parseDocument(out).errors;
    if (errors.length) {
      throw new Error(`${file.label}: the migrated text no longer parses after the pointer-field pass (${errors[0].message}). Nothing was written.`);
    }
    outputs.push([file, out]);
  }
  for (const [file, out] of outputs) {
    if (!dryRun) fs.writeFileSync(file.path, out, "utf-8");
    console.log(`${dryRun ? "would migrate" : "migrated"}  ${file.label}`);
  }
  const changed = outputs.length;

  console.log(`\n${changed} of ${paths.length} file(s) ${dryRun ? "would change" : "changed"}.`);
  if (notes.length) {
    console.log(`\n${notes.length} note(s):`);
    for (const n of notes) console.log(`  ${n}`);
  }
  console.log("\nNext: dsds-format <the same files> (puts any field the migration added in its place),\nthen dsds-validate <the same files>.");
}

module.exports = { parseFile, migrateFile, applyFlips, pointerFieldsPass };
