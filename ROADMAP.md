# Roadmap

Planned features for `cssgrep`. The search engine is complete; this is breadth:
grep-family flags plus HTML-specific capabilities plain grep can't offer.

**Process:** implement in phase order. **Each feature is its own commit** (code +
tests + docs, suite green) — see `CLAUDE.md`. Phases are independently shippable.

**Status: all phases below are implemented (2026-06-29).** Phases 0–4 shipped:
`-m`, `-l`/`-L`/`-q`, `--attr`/`--text`, `--json`, `-0`/`--null`, `--parent`,
and `-A`/`-B`/`-C`. This file is kept as the design record; future work can
extend it.

**Shipped beyond the original plan:** `-M`/`--max-total` (global match cap,
vs per-file `-m`); matched-node highlighting inside `--parent -p` output; and
`-i`/`--ignore` + `--ignore-file` (gitignore-flavored globs to skip paths while
recursing).

## Output-mode model (design backbone)

New flags compose cleanly only as three independent axes; place each feature on
one axis and extend the `parseArgs` validation matrix to reject illegal combos.

1. **Target** — which node a match resolves to.
   - default: the matched node.
   - `--parent <n>`: the n-th element ancestor (dedup by identity). Composes with
     every print mode.
2. **Print mode** — what is printed per match. Mutually exclusive, exactly one:
   - line (default): source line + optional `-n` locator + color.
   - `-p`: pretty-printed HTML.
   - `--attr <name>`: value of attribute `<name>` (skip matches lacking it).
   - `--text`: collapsed text content.
   - `--json`: one NDJSON record per match.
3. **Aggregate** — suppresses per-match content. At most one:
   - `-c` (exists), `-l`/`-L` (filenames), `-q` (quiet, status only).

Modifiers on line mode only: context (`-A`/`-B`/`-C`) and `-0`/`--null`
separator. `-m`/`--max-count` caps matches in any mode.

---

## Phase 0 — Project hygiene (no behavior change)

- `LICENSE`: ISC (matches `package.json`); holder `matias`, year `2026`. Set
  `package.json` `"author"`.
- CI: `.github/workflows/test.yml` — on push/PR, `actions/setup-node` from
  `.nvmrc`, `npm ci`, `npm test`.
- Tidy: add a `break` to the `--help` case in `parseArgs` (harmless fall-through
  after `process.exit(0)`).

## Phase 1 — grep-parity aggregate + limit flags

`-l`/`--files-with-matches`, `-L`/`--files-without-match`, `-q`/`--quiet`,
`-m <n>`/`--max-count <n>`.

- Generalize the short-cluster value-taking logic (today only `-w`): a set of
  value-taking short flags (`w`, `m`, later `A`/`B`/`C`) that consume rest-of-
  cluster or next arg. Add booleans `l`, `L`, `q`.
- Pass a display `name` (path, or `(standard input)` for stdin) into
  `searchSource` so `-l`/`-L`/`-c` have a name even for single-file/stdin.
- `-l`/`-L`: push `name` when count `>0` / `===0`; no per-match lines.
- `-q`: emit nothing; `main` stops at the first match (`total>0`).
- `-m`: slice matches to n everywhere; `-c` reports `min(count, m)`.
- Optional: use `selectOne` when only existence matters (`-q`, `-l`).
- Validation: at most one of `-c`/`-l`/`-L`/`-q`; they forbid print-mode flags.

## Phase 2 — HTML extraction print modes

`--attr <name>`, `--text`.

- `--attr`: read `el.attribs[name]`; skip nodes without it; value becomes the
  printed content (flows through prefix/locator/color path).
- `--text`: small dependency-free `textOf(node)` (recurse children, concat
  `type==='text'` `.data`); collapse whitespace + trim; one line per match.
- Both honor `-n`, `-w`, and `--parent`.
- Validation: `-p`/`--attr`/`--text`/`--json` mutually exclusive.

## Phase 3 — Scripting output

`-0`/`-Z`/`--null`, `--json`.

- `-0`: replace the `:` after the filename with NUL (mainly for `-l` +
  `xargs -0`); centralize the file-separator char.
- `--json`: NDJSON, one object per match: `{"file","line","col","html","text"}`
  (+ `"attr"` when `--attr` set). Own emitter; ignores color/context.

## Phase 4 — Context (line + structural)

Most involved; refactors the line-output path.

### Line context — `-A <n>`/`--after-context`, `-B <n>`/`--before-context`, `-C <n>`/`--context`
- Add `lineTextAt(starts, src, lineNo)` (reuse `starts` + CRLF stripping).
- Per file: collect matched line numbers → expand to `[L-before, L+after]` →
  merge overlapping/adjacent ranges → emit. `--` separator between
  non-contiguous groups; dedupe physical lines (minified = all on line 1).
- Grep separators: match lines `:`, context lines `-`; with `-n`, context lines
  show the line number but no col; highlight only on match lines.
- Docs note: line-oriented, so most useful on formatted HTML.
- Validation: line mode only; reject with `-p`/`-c`/`-l`/`-q`/`--attr`/`--text`/`--json`.

### Structural context — `--parent <n>` (the novel one)
- A **Target-axis** modifier, not a print mode: re-points each match to its
  n-th element ancestor, then the active print mode runs on that ancestor.
  Climb `el.parent` while it's an element, stop at the document root (clamp n).
  Dedup ancestors by identity.
- Killer combo `--parent <n> -p`: pretty-print the containing node — structural
  context line-based `-A`/`-B` can't express
  (`cssgrep '.price' -p --parent 2 page.html`).
- Line mode: print the ancestor's opening-tag line + position via its
  `startIndex`.

---

## Files touched (most phases)

- `index.js`: `parseArgs` (flags + validation matrix), `searchSource` (mode
  dispatch; consider extracting `emitLine`/`emitContext`/`emitJson`), new
  helpers (`lineTextAt`, `textOf`, `ancestor`, range-merge), `main`, `USAGE`.
- `test.js`: a `check(...)` per new behavior.
- `README.md`: options table + short sections for extraction / context / `--parent`.
- New in Phase 0: `LICENSE`, `.github/workflows/test.yml`.

## Verification

`npm test` after each phase, plus manual smoke tests on the bundled minified
`index.html` and a formatted fixture:

- `cssgrep 'a' --attr href index.html`
- `cssgrep 'h1' -p --parent 1 index.html`
- `cssgrep 'li' -C1 formatted.html`
- `cssgrep 'a[href]' -l -r .` ; `cssgrep '.x' -q file.html; echo $?`
