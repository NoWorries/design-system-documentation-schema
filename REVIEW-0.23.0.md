# DSDS 0.23.0 — release review

Reviewed 2026-10-15 on branch `0.23.0`, against tag `v0.22.0`. A working note, like `PLAN-inline-links.md`. Don't commit it.

## Verdict

It's ready to release once one bug is fixed. 0.23.0 is additive: every document that validates under 0.22.0 still validates, and there's no migration script. The inline-link design fits DSDS: it reuses `to` addressing exactly, adds no field and no rule id, and turns unchecked backtick mentions into checked links. All checks pass, and the implementation matches the spec text everywhere except one place (Finding 1).

## What's in the release

### Inline links in prose (the main feature)

- **The feature:** a Markdown field can link to something in the project, as `[text](dsds:target)` or `<dsds:target>`. What follows `dsds:` is written exactly like a `to`. Reference-style links count too, and the scheme is case-insensitive.
- **Not a relationship:** an inline link is a mention. It adds nothing to `uses`, and it never shows up when relationships are read backwards.
- **Validator:** `DSDS-05` and `DSDS-08` check link targets the same way they check a `to`, with the same rule for when a miss is an error and when it's a warning. `DSDS-08` also reports a target that isn't shaped like a `to`. A finding for an inline link carries an `offset`: where the link starts in the field.
- **Parser:** links are found with `mdast-util-from-markdown`, an `optionalDependency`. It's loaded only when a field contains `dsds:`. If it's missing, or Node is older than 20.19, the validator skips inline links and warns, which fails `--strict`.
- **Resolver:** `resolve.js` adds an `inlineLinks` list only when a project has some, so the six existing test vectors are unchanged. It has two new problem codes, `malformed-link` and `inline-links-skipped`, and there's a new vector, `examples/vectors/inline-links/`.
- **Security:** a renderer must never output a `dsds:` URL as an `href`. `check:docs` now fails if a built page has one.
- **Docs:** Specification §2.5 and §6.5, processing model §2.4, the Security page and the style guide are updated, and the Quick Start has a new step 13. `llms-small.txt`, `AGENTS.md` and all four skills explain inline links.
- **Tests:** 4 new invalid fixtures, 15 unit cases in `scripts/checks/check-inline-links.js`, and one link of each form in `examples/entries/button.yaml`.

### `description` is Markdown everywhere

- **The change:** `description` on an entry, a shared entry, a section and an example now uses `common/markdown.schema.yaml`. It's still a string in JSON, so no document's validity changes.
- **Effect on tools:** a description containing `*`, `_` or `<` may render differently in a tool that now treats it as Markdown.

### Stable ids and UUIDs

- **Stable ids:** Specification §3.1 says a published `id` SHOULD NOT change, and explains how to rename instead: change `name`, or keep a deprecated stub whose `replacedBy` points at the new entry. This is guidance only, since a validator can't compare versions.
- **UUIDs:** a lowercase UUID is now documented as a valid `id`. It already validated.

### Committed since `v0.22.0`

- **PR #51 (Mark Toadvine):** Quick Start step 12 now shows how to identify shared accessibility guidance.
- **Your own commits:** a homepage update, style tweaks, and a summary added to the 0.22.0 CHANGELOG entry.

### Uncommitted

Everything else, about 80 files. Most are version bumps to 0.23.0: `$id`s, `schemaVersion` in examples and vectors, the bundles, and `TARGET_VERSION` in `migrate-to-0.20.js`. The real changes are in:

- `scripts/lib.js` and `scripts/validate/validate.js`
- `scripts/resolve/resolve.js`
- `scripts/checks/check-inline-links.js` (new) and `scripts/checks/check-internal-links.mjs`
- `scripts/generate/sync-style-guide.mjs`, which now skips code when checking links
- the schema files, the docs pages, and the new fixtures and vector

## Findings

### 1. Bug: an inline link in a guideline item's `example` is never checked

- **The problem:** Specification §2.5 lists "an example's `description`" as a Markdown field. But a guideline item holds one `example` (singular), and `markdownFields()` in `scripts/lib.js` only reads `examples` (plural). So a link there is never found, never checked by `DSDS-05`/`DSDS-08`, and missing from the resolver's `inlineLinks`.
- **Reproduced:** a guideline whose `statement` holds `<dsds:no-such-one>` and whose `example.description` holds `[this](dsds:no-such-two)`. The validator reports only the first.
- **The fix:** in `markdownFields()`, also read `item.example` on section items. It's a one-line change, plus a case in `check-inline-links.js` or a fixture.
- **dsds-mcp:** it vendors `lib.js`, so it has the same bug. Re-vendor after the fix.

### 2. The CHANGELOG doesn't mention PR #51

Mark Toadvine's change to Quick Start step 12 is in this release but not in the `[0.23.0]` entry. He's already in `package.json`, the README and the Overview. Suggest a line under a "Docs" heading crediting #51.

### 3. Housekeeping before you commit

- **`PLAN-inline-links.md`** is untracked and marked "Don't commit it". Leave it out (this file too).
- **`site/dist/v0.23.0/`** is untracked. Earlier versioned archives are committed, so this one should go in with the release.
- **The CHANGELOG date** is 2026-10-13. Update it if you tag later.

### 4. Risks to mention in the release notes (no change needed)

- **Rendering:** a tool that showed `description` as plain text may now render Markdown in it. The CHANGELOG already says this.
- **Old Node:** on Node older than 20.19, or with `--omit=optional`, inline links aren't checked. The warning makes this visible, and `--strict` fails on it.

## Checked

- **Spec repo:** `npm run check`, `npm run build` and `npm run check:docs` all pass. `npm run lint` gives 54 files, 45 clean, 10 warnings, the same as 0.22.0.
- **Spec text against code:** the parser rule, case-insensitive scheme, decoding of escapes, autolink text order, and "not a relationship" all match the implementation, except Finding 1.
- **Unexplained diffs:** none. Every changed script is either a version bump or part of the inline-link work.
- **dsds-mcp:** already at 0.6.0 with `BUNDLED_VERSION = '0.23.0'` and the optional parser added. Only Finding 1 is outstanding there.

## To release

1. Fix Finding 1, and add a test for it.
2. Add the #51 line to the CHANGELOG, and check the date.
3. Re-run `npm run check`, `npm run build` and `npm run check:docs`.
4. Commit, including `site/dist/v0.23.0/` and leaving out the two working notes. Then tag `v0.23.0`.
5. Re-vendor dsds-mcp from the tag, and release it.
