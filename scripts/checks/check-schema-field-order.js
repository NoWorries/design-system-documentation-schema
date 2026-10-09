#!/usr/bin/env node
// STYLE_GUIDE.md tells authors to write a document's fields in the order the schema files
// list them, which makes those files the only record of that order. This asserts the schema
// files don't contradict each other about it.
//
// A kind file narrows some of the fields its base already declares - entries/token.schema.yaml
// redeclares `id` to loosen the pattern, every kind file redeclares `kind` to pin a const. When
// a kind file lists those shared fields in a different order than the base does, the two files
// disagree about the order authors are being told to follow. That happened: token.schema.yaml
// listed `kind, metadata, id` while entry.schema.yaml listed `id` first.
//
// Only the shared fields are checked, and only their order relative to each other. A kind file
// is free to put its own novel fields wherever it likes, and they do vary - definitions puts
// its novel field after `items` while guidelines and steps put theirs before. Nothing depends
// on that placement, because lib.js's entryFieldOrder drops the redeclared fields and reads the
// novel ones as a group.
"use strict";

const fs = require("fs");
const path = require("path");
const { schemaDir, declaredProps, loadYaml, walkYamlFiles } = require("../lib");

// Each base file, paired with the directory holding the files that compose onto it via `allOf`.
const FAMILIES = [
  { base: "entries/entry.schema.yaml", dir: "entries" },
  { base: "sections/section.schema.yaml", dir: "sections" },
];

function membersOf(family) {
  return fs
    .readdirSync(path.join(schemaDir, family.dir))
    .filter((file) => file.endsWith(".schema.yaml") && `${family.dir}/${file}` !== family.base)
    .sort()
    .map((file) => `${family.dir}/${file}`);
}

let ok = true;
let checked = 0;

for (const family of FAMILIES) {
  const baseOrder = declaredProps(family.base);

  for (const member of membersOf(family)) {
    let own;
    try {
      own = declaredProps(member);
    } catch {
      // A member that declares no properties of its own has no order to disagree about.
      continue;
    }

    const shared = own.filter((key) => baseOrder.includes(key));
    const expected = baseOrder.filter((key) => shared.includes(key));
    checked += 1;

    if (shared.join(" ") === expected.join(" ")) continue;

    // Name the specific pair that's backwards - more useful than printing both whole lists.
    const at = shared.findIndex(
      (key, i) => i + 1 < shared.length && expected.indexOf(key) > expected.indexOf(shared[i + 1]),
    );
    console.error(
      `✗ schema/${member}: lists \`${shared[at]}\` before \`${shared[at + 1]}\`, but ` +
        `schema/${family.base} declares them the other way round. Both files tell authors what ` +
        `order to write these fields in, so they have to agree. Expected these shared fields in ` +
        `the order [${expected.join(", ")}], found [${shared.join(", ")}].`,
    );
    ok = false;
  }
}

// A schema file's own `example:` blocks are what an agent copies - they render into the
// Schema page's property tables and into the bundled schema. An example that contradicts
// the field order (what dsds-format applies) teaches the wrong order from the most authoritative place there is, so walk
// every one of them. Found exactly that: component.schema.yaml's `specs` example listed
// `rel` before `href`.
const EXAMPLE_ORDERS = (() => {
  const refFile = loadYaml(path.join(schemaDir, "common", "ref.schema.yaml"));
  const combo = declaredProps("common/combo.schema.yaml");
  const ref = Object.keys(refFile.oneOf.find((m) => m.properties).properties);
  return { ref, combo };
})();

// Every object nested anywhere inside a value, with a pointer to it.
function objectsIn(node, at, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => objectsIn(v, `${at}[${i}]`, out));
    return out;
  }
  out.push([node, at]);
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object") objectsIn(v, `${at}/${k}`, out);
  }
  return out;
}

function checkExamples(relPath) {
  const doc = loadYaml(path.join(schemaDir, relPath));
  for (const [obj, at] of objectsIn(doc, "")) {
    if (!("example" in obj)) continue;
    for (const [candidate, where] of objectsIn(obj.example, `${at}/example`)) {
      const keys = Object.keys(candidate);
      const order =
        "to" in candidate || "href" in candidate
          ? EXAMPLE_ORDERS.ref
          : "subject" in candidate && "items" in candidate
            ? EXAMPLE_ORDERS.combo
            : null;
      if (!order) continue;
      const present = keys.filter((k) => order.includes(k));
      const expected = order.filter((k) => present.includes(k));
      if (present.join(" ") === expected.join(" ")) continue;
      console.error(
        `✗ schema/${relPath}${where}: example lists [${present.join(", ")}], but its own ` +
          `schema declares [${expected.join(", ")}]. An example is what gets copied, so it has ` +
          `to follow the order the file asks for.`,
      );
      ok = false;
      exampleFailures += 1;
    }
  }
}

let exampleFailures = 0;
let exampleCount = 0;
for (const file of walkYamlFiles(schemaDir)) {
  const rel = path.relative(schemaDir, file).replace(/\\/g, "/");
  exampleCount += 1;
  checkExamples(rel);
}

if (ok) {
  console.log(
    `✓ All ${checked} kind schema(s) agree with their base's field order, and every \`example:\` block in ${exampleCount} schema file(s) follows its own declared order.`,
  );
}
process.exit(ok ? 0 : 1);
