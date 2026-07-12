# Roadmap

Planned features for `cssgrep`. The search engine is complete; this is breadth:
grep-family flags plus HTML-specific capabilities plain grep can't offer.

**Process:** implement in phase order. **Each feature is its own commit** (code +
tests + docs, suite green) — see `CLAUDE.md`. Phases are independently shippable.

**Status: all phases (0–11) are done (7 resolved as "no flag" — see below).**
Phases 0–4 shipped:
`-m`, `-l`/`-L`/`-q`, `--attr`/`--text`, `--json`, `-0`/`--null`, `--parent`,
and `-A`/`-B`/`-C`. This file is kept as the design record; future work can
extend it.

**Shipped beyond the original plan:** `-M`/`--max-total` (global match cap,
vs per-file `-m`); matched-node highlighting inside `--parent -p` output; and
`-i`/`--ignore` + `--ignore-file` (gitignore-flavored globs to skip paths while
recursing).

**v1.1 (grep-parity round):** `-H`/`--with-filename` + `--no-filename`,
`-s`/`--no-messages`, automatic binary-file skipping, `--include`/`--exclude`
globs with brace alternation (`{a,b,c}`), and `--max-depth`. Plus CI hardening
(3-OS × 2-Node test matrix, npm publish provenance, binary smoke test) and repo
scaffolding (issue/PR templates, editorconfig).

**v1.2 (correctness & fidelity round): implemented 2026-07-02 — see Phase 5
below.** Bugs found in a 2026-07-02 code audit, plus grep-parity deviations
decided that day. All nine items shipped, one commit each.

**v1.3+ (planned, 2026-07-02): Phases 6–11 below.** Direction chosen; design
decisions still open — each phase lists its **Design questions**, to be settled
before (or as the first commit of) that phase. Phase 6 (library-first refactor)
is the enabler: the vim/neovim plugin will live in a separate repo consuming
cssgrep as a library, and Phases 8–10 build on the lib/CLI split.

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

## Phase 5 — Correctness & fidelity round (v1.2)

Fixes from the 2026-07-02 audit. Ordered by severity; each item is one commit
(code + tests + docs, suite green). Behavior decisions (column unit, `--color`,
`-c` zeros, symlinks) were made 2026-07-02 and are baked into the items below.

1. **Flush-safe exit — never truncate piped output.** `main` ends with one big
   `process.stdout.write(...)` immediately followed by `process.exit(...)`;
   pipe writes are async in Node, so large output is cut off (observed: 200k
   matches → ~2.4k lines through a pipe). Set `process.exitCode` and return
   instead of calling `process.exit`. Test: a generated many-match file must
   come through a pipe complete.

2. **Missing option values fail cleanly.** A value-taking flag with no value
   must `fail("option X requires a value")` (exit 2). Today `--ignore`/`-i` as
   the last arg crashes with a `TypeError` stack trace (exit 1), and a bare
   trailing `--attr` is *silently ignored* (`undefined` fails the `!= null`
   check). Hook the check into the long-option `value()` helper and the
   short-cluster value path.

3. **Byte-accurate columns.** `-n` and `--json` report the column in UTF-16
   code units — wrong for vim (`grepformat` `%c` is bytes) and not characters
   either (astral chars count 2). Report byte columns:
   `Buffer.byteLength(<line prefix>)` + 1 at emit time. The in-line highlight
   math stays code-unit based internally (it slices JS strings). Update the
   column-semantics wording in README + man ("byte column, as vim expects").

4. **`**` glob segment boundary.** `--include '**/foo.html'` compiles to
   `.*foo\.html` and wrongly matches `barfoo.html`. Compile `**/` to
   `(?:.*/)?` so `**` crosses whole segments only.

5. **`--attr` fidelity.** (a) htmlparser2 lowercases HTML attribute names, so
   `--attr HREF` can never match — lowercase the flag value in `parseArgs`.
   (b) `searchSource` returns the selector-match count even when every node was
   skipped for lacking the attribute, so `--attr` can print nothing yet exit 0;
   return the *emitted* record count from the per-target loop (also makes the
   `-M` budget count printed records).

6. **Bare `--color` means `auto` (grep parity).** Today a bare `--color` forces
   `always`; GNU grep treats it as `auto`. Match grep; `--color=always` remains
   for forcing color into pipes. Update USAGE/README/man.

7. **`-c` prints zero counts (grep parity).** Multi-file `-c` prints `file:0`
   for files without matches; single file/stdin prints `0`. Exit status still 1
   when nothing matched, exactly like grep.

8. **`-S`/`--follow` — follow symlinks under `-r`.** Today `-r` silently skips
   symlinked files and dirs. Add `-S`/`--follow` (off by default, ripgrep's
   model) that follows symlinks while recursing, with a visited-realpath set to
   guard against loops. Document the default. All four doc surfaces + the three
   completion files.

9. **Small robustness fixes** (one commit): surrogate-safe `-w` truncation
   (never slice an astral char in half → invalid output bytes); apply the
   binary sniff to stdin, not just files; sort `walk()` entries so multi-file
   output order is deterministic across platforms; document how `-M` composes
   with `-l`/`-L` (the budget counts matches, not files).

---

## Phase 6 — Library-first refactor (v1.3 enabler) — implemented 2026-07-04

Make cssgrep a library with a CLI artifact, so a vim/neovim plugin (separate
repo) and other tools can consume the engine programmatically. Before this,
`require('cssgrep')` *executed the CLI* — `index.js` called `main()` at load.

- Split `index.js` → `lib.js` (engine: parse, select, `lineIndex`/
  `offsetToPosition`, `textOf`, `ancestor`/`retarget`) + `cli.js` (argv
  parsing, walk, glob helpers, stdin, `prettyPrint`, output emitters, exit
  codes). `bin` → `cli.js`; `main`/`exports` → `lib.js`.
- Update in the same commit: Bun `build:*` scripts and `scripts/build-sea.js`
  entry point, `files` in `package.json`, and the spawn target in `test.js`.
- Public API: `search(html, selector, opts) →
  [{ start, end, line, col, tag, attribs, html, text, node }]`, positions
  computed with the existing helpers.
- Ship a hand-written `index.d.ts` (dependency-light; no build step).
- Semver: minor (1.3.0) — the CLI contract is unchanged, the lib surface is new.

**Decisions (2026-07-04):**
- **Result shape: plain objects** — `{ start, end, line, col, tag, attribs,
  html, text }` — plus a `node` property holding the raw htmlparser2 element,
  documented as an unstable/advanced escape hatch (the rewrite phase and the
  vim plugin can reach the DOM without the lib's contract owning a dep's
  types).
- **Scope: strings only.** The lib takes an HTML string. File
  discovery/walking, globs, ignore rules, stdin, the binary sniff, and
  `prettyPrint` (js-beautify) all stay in the CLI.
- **Error model: throw** (e.g. on an unparsable selector); the CLI catches
  and maps to exit 2.
- **Module format: CJS only**, matching the repo; ESM consumers use Node's
  CJS interop. No build step, hand-written `index.d.ts` for types.

**API revision (2026-07-07):** the original one-shot `search(html, selector,
opts)` re-parsed per call and left the CLI running parse/select itself — the
CLI and lib had drifted apart instead of the CLI wrapping the lib. Replaced
by **`parse(html)` → document handle with `.search(selector, opts)`**: the
parse and line index are paid once per document and any number of selectors
query the same tree. `searchSource` now consumes it, so the CLI's "-e parses
once" is a property of the lib, not CLI-private plumbing. Match
`line`/`col`/`html`/`text` became lazy getters (aggregate-style consumers pay
no position math; `JSON.stringify` still serializes them) and `node` became
non-enumerable (htmlparser2 nodes are circular — matches now stringify
cleanly).

## Phase 7 — `-v`/`--invert-match`: use-case analysis → decision — decided 2026-07-04

An analysis item, not an implementation item: CSS may already cover inversion.
`css-select@7` supports `:not()` **and `:has()`**, so the classic asks are
expressible today:

- "files without a match" → already `-L`.
- "elements that don't match X" → `:not(X)`; but the bare complement matches
  nearly every element in the document (the universe problem).
- "containers lacking a descendant" — the real-world ask (*divs with no link*,
  *imgs with no alt*) → `div:not(:has(a))`, `img:not([alt])`.
- "matches of A except those inside B" → `A:not(B A)`.

**Decision: (a) — no flag.** Verified empirically against the shipped
css-select: `:has()` works, and `:not()` accepts complex selectors *and
selector lists* (`a:not(nav a, footer a)`), so every use case above is
expressible directly in the selector — which also names the inversion
universe on the left of `:not()`, the thing a flag would have to reinvent
(bare `:not(a)` matches nearly every element in the document). Shipped as an
"Inverting matches" recipe section in README + man, with `check(...)` cases
pinning each recipe so the docs can't silently rot. As a follow-up, `-v` and
`--invert-match` fail with a *teaching* error (exit 2) that points at the
recipes instead of a bare "unknown option" — the slot stays unassigned (it was
deliberately not reused for e.g. a version alias) so reviving it for
inversion would not be a breaking change.

Rejected alternative, kept for the record in case a concrete use case
`:not()`/`:has()` cannot express ever appears: **(b)** `-v` as sugar — apply
the selector, emit the complement within a universe named by a second
`--within <sel>` scope; would also need semantics for `-c -v`/`-l -v` and
`--parent`.

## Phase 8 — Multiple selectors with labels (`-e`) — implemented 2026-07-04

Repeatable `-e [label=]<selector>` turns cssgrep into a multi-field extractor
in one parse pass — the scraping use case:

```sh
cssgrep -e 'title=h1' -e 'price=.card .price' --json page.html
```

emits NDJSON records tagged with which selector hit.

- Line mode: `file:line:col [label] text` — the label rides inside grepformat's
  `%m`, so vim integration is untouched. Yellow when coloring.
- `--json`: a `"label"` field, present only when `-e` is used.
- Ordering: DOM order across all selectors; a node matching two selectors
  emits once per selector (ties keep `-e` order). `--parent` dedups per
  (ancestor, label).
- Supersedes the deferred `-f`/`-e` item below.

**Decisions (2026-07-04):**
- **Label syntax: `ident=` prefix** (`[A-Za-z_][A-Za-z0-9_-]*` before the
  first `=`). Verified unambiguous: css-what tokenizes a `=` outside brackets
  as an unmatchable tag (`a=b` → tag `=b`), so the prefix can never shadow a
  *working* selector; `[href=x]` stays a selector.
- **Default label: the selector text.** `[label]` and the JSON field are
  always present when `-e` is used; a bare positional selector never shows
  them (output unchanged).
- **Budgets count overall**: `-m`/`-M` truncate the merged document-order
  stream, like grep caps lines regardless of which pattern matched.
- **Print modes stay global** across all `-e` selectors. Per-selector
  extraction (`price=.price@data-value`) remains a possible future extension;
  `--json`'s `html`/`text` fields already cover most multi-field scraping.
- With `-e`, every positional is a file path (grep `-e` semantics) — a
  mistyped path reports as unreadable rather than being re-guessed as a
  selector.

## Phase 9 — Rewrite mode (HTML refactor operations) — implemented 2026-07-07

The genuinely novel one: edit matched nodes, not just report them. HTML-shaped
refactor ops: `--add-class <c>`, `--remove-class <c>`, `--set-attr k=v`,
`--remove-attr k`, `--rename-tag <t>`. Start with the class/attr four; node
removal/unwrap later if wanted.

- **Fidelity is the core design decision.** Re-serializing the whole DOM
  (dom-serializer) normalizes quoting/entities/whitespace everywhere —
  unacceptable for a refactor tool. Preferred approach, aligned with this
  project's byte-offset strength: **surgical byte-splice**. Every op touches
  only the matched element's *opening tag*: take its byte range (startIndex →
  end of the open tag), re-lex just that substring with a small local
  attribute-span lexer (htmlparser2 doesn't expose attribute offsets), splice
  the edit, leave every other byte identical. Apply splices back-to-front so
  earlier offsets stay valid.
- Output: rewritten document to stdout for a single input; `--diff` emits a
  unified diff for any number of files.
- Library API first (depends on Phase 6): a method on the `parse()` document
  handle — `doc.transform(selector, ops) → { html, edits: [{start, end,
  before, after}] }`; the CLI is a thin wrapper.
- Validation: rewrite is a new *program mode*, not a fourth output axis — it
  excludes the print and aggregate axes entirely (reject `-p`, `--json`, `-c`,
  `-l`, `-q`, context flags). Extend the matrix accordingly.

**Decisions (2026-07-07):**
- **Splice, not re-serialize** — never reformat bytes the edit didn't touch.
- **Exit codes, grep-flavored:** 0 = edits made, 1 = no matches/no edits,
  2 = error.
- **No in-place writes.** stdout (single input) + `--diff` (any number of
  files) only; a diff is applied — reviewably, revertably — with `git apply`
  or `patch`, so cssgrep never modifies a file. `--write` (atomic tmp+rename)
  can be added later if bulk refactors demand it.
- **Multiple ops compose in a fixed documented pipeline order** per element:
  rename-tag → remove-attr → set-attr → remove-class → add-class.
  Deterministic regardless of argv order (`--remove-attr class --add-class x`
  always yields `class="x"`). Note re-matching a modified node cannot happen
  by construction: the selector runs once against the parsed original
  document; edits are byte splices computed afterward — the tree is never
  re-queried.
- **Non-UTF-8 input: refuse to rewrite** (exit 2, decode/re-encode round-trip
  check) — the rewriter must never corrupt bytes it didn't edit, and a lossy
  UTF-8 decode written back would. Search modes keep today's lossy-display
  tolerance.
- **Overlaps are safe by construction:** when a selector matches both an
  ancestor and its descendant, all edited spans (both opening tags; for
  rename, both closing tags too) are pairwise disjoint because of HTML
  nesting, so back-to-front splicing cannot conflict. The real trap is
  elements *without* a closing tag — voids (`<img>`), self-closing (`<x/>`),
  parser-implied closes (`<li>` without `</li>`): `--rename-tag` must verify
  an explicit closing tag exists at the node's tail before splicing it.

## Phase 10 — Watch mode (`--watch`) — implemented 2026-07-07

Re-run the search when watched files change — for editor/build-tool
integration.

- Watch the resolved path set (under `-r`, the walked tree — picking up new
  files that match the include/ignore rules); debounce bursts; re-run, re-emit.
- Validation: `--watch` requires file paths (stdin impossible); reject with
  `-q` and with the rewrite ops; `-c`/`-l` just re-run and reprint. Exit only
  on signal (SIGINT → exit 0, matching `watch(1)`).

**Decisions (2026-07-07):**
- **Backend: native `fs.watch` with `{recursive: true}`**, no new dependency
  and no polling fallback in v1. Verified working on Linux for our supported
  Node range (Linux recursive support landed in Node 19.1; we require
  ≥ 20.19); native on macOS/Windows. Documented caveat: unreliable on
  network/virtual filesystems — a `--poll` escape hatch can be added later if
  someone hits it.
- **Output is adaptive, mirroring the `--color=auto` convention.** On a TTY:
  clear screen + reprint the full results each run (live view). Piped: never
  emit escape codes — append each run's results after a `== HH:MM:SS … ==`
  separator line. `--no-clear` forces append mode on a TTY (tmux scrollback,
  `script(1)`); there is deliberately no "force clear into a pipe" flag.
- **`--json` is the machine protocol:** an NDJSON stream — each rerun emits
  `{"event":"run","changed":…,"matches":n}` followed by the match records.
  Never clears; rejects `--no-clear`.
- **New files: re-walk on every (debounced) change.** Each rerun repeats the
  exact walk a fresh invocation would do, so `--include`/`--ignore`/`--ext`
  rules apply to new files automatically and deletions drop out — no
  event-bookkeeping, identical semantics to a non-watch run. A directory scan
  per rerun is fine at HTML-project scale.

## Phase 11 — Performance round (measure first) — implemented 2026-07-07

Investigation phase: no optimization lands without a benchmark showing it
matters.

- **Item 1 — bench harness.** `bench/bench.js` (`npm run bench`): generated
  fixtures (8 MB minified single line with 40k matches; a 1000-file tree; a
  2000-deep nesting doc), median wall times of the CLI as a subprocess, peak
  RSS via child `resourceUsage`.

**Baseline (2026-07-07, node 22, Linux x64, dev machine):**

```
startup: --version                             43.4 ms
huge 8MB minified: .price (40k matches)      CRASHES (RangeError, exit 1)
huge 8MB minified: -q (existence only)        359 ms
huge 8MB minified: -c (count only)            360 ms
huge 8MB minified: zero matches               298 ms
tree 1000 files: -rn .hit (100 hits)           92 ms   60 MB peak
deep 2000-nest: .leaf --text                   61 ms
```

**Findings (the harness paid for itself on day one):**

1. **Many matches on one physical line is broken** — the marquee minified
   use case. (a) Default line mode prints the whole physical line once *per
   match*, where grep prints a matching line *once*: 40k copies of an 8 MB
   line. (b) All output is built as a single `out.join('\n')` string, which
   blows V8's max string length → `RangeError`, exit 1, zero output. (c)
   `bcol` recomputes `Buffer.byteLength` of the line prefix per match —
   O(offset) per match, quadratic per line.
2. **Startup** is 43 ms; `js-beautify` + `dom-serializer` account for ~13 ms
   and are only needed by `-p` → lazy-require them (~30% cut for `grepprg`).
3. `lineIndex` on a zero-match 8 MB file is a few ms of a ~300 ms
   parse-dominated run — build it only when something will be emitted (free
   one-line guard).

**Decisions (2026-07-07):**
- **Benches run manually**, never as a CI gate — runner timing is too noisy.
  Compare on one machine before/after.
- **Parallel file processing: not worth it.** 1000 files scan in ~92 ms
  serially; worker threads would add complexity for a regime (thousands of
  files) the tool doesn't operate in. Revisit only with a real workload.
- **Streaming parse: explicit non-goal.** css-select needs the full tree, and
  whole-file DOM at 8 MB costs ~200 MB peak — acceptable for HTML documents.
- **No hard startup target**; 43 → ~30 ms via lazy-require is the win worth
  taking.

**Fix plan (one commit each):** grep-parity line dedup in no-locator line
mode; chunked stdout writes (no giant join); incremental per-line byte-column
cache; lazy-require the `-p`-only deps (+ the zero-match `lineIndex` guard).
All four shipped 2026-07-07.

**After (same machine, same day):**

```
startup: --version                             37.9 ms   (was 43.4)
huge 8MB minified: .price (40k matches)         406 ms   (was: CRASHED)
huge 8MB minified: -n -w60 (40k locators)       414 ms   (was 9400)
huge 8MB minified: zero matches                 275 ms   (was 298)
tree 1000 files: -rn .hit (100 hits)             79 ms   (was 92)
deep 2000-nest: .leaf --text                     52 ms   (was 61)
```

The many-match emission path went from quadratic (or fatal) to
parse-dominated; the startup saving is smaller than the deps' standalone
require cost because dom-serializer shares domhandler/entities with
htmlparser2, which every mode loads anyway.

### Downstream (not in this repo)

The vim/neovim plugin becomes its own repo (e.g. `vim-cssgrep`) once Phase 6
ships a stable lib + CLI. Until then the README `grepprg` snippets remain the
supported integration.

### Ordering

Phase 6 first — it enables the external vim plugin and Phases 8–10 build on
the lib/CLI split (Phase 9 puts `transform()` in the lib). Phase 7 is
analysis-only and can happen anytime. Phase 11 is independent; its
startup-latency item can be pulled forward at will.

---

## Files touched (most phases)

- `index.js`: `parseArgs` (flags + validation matrix), `searchSource` (mode
  dispatch; consider extracting `emitLine`/`emitContext`/`emitJson`), new
  helpers (`lineTextAt`, `textOf`, `ancestor`, range-merge), `main`, `USAGE`.
- `test.js`: a `check(...)` per new behavior.
- `README.md`: options table + short sections for extraction / context / `--parent`.
- New in Phase 0: `LICENSE`, `.github/workflows/test.yml`.

## Deferred / under discussion (not implemented)

Considered during the v1.1 round and intentionally left out for now:

- **`-v`/`--invert-match`** — graduated to Phase 7 (use-case analysis →
  decision).
- **Wider distribution** — Homebrew tap/formula and a Scoop manifest. More reach,
  but ongoing per-release maintenance; deferred.
- **`-f` (patterns from a file)** — low value: a CSS selector list (`a, .b`)
  already expresses multi-selector OR in one argument. Multiple `-e` is now
  Phase 8 (labeled selectors), which supersedes the old `-e` idea here.
- **Repo docs polish** — a `CONTRIBUTING.md`. Add when desired.
- **Automated changelog** — `CHANGELOG.md` is hand-maintained (Keep a Changelog).
  Switching to `conventional-changelog` would require adopting Conventional
  Commit message prefixes (`feat:`/`fix:`) as the repo convention first.
- **`-a`/`--text` binary override** — force-parse a file the binary heuristic
  skipped. Add if a real need appears.

## Verification

`npm test` after each phase, plus manual smoke tests on the sample pages in
`testdata/` (see `testdata/README.md`):

- `cssgrep 'a' --attr href testdata/links.html`
- `cssgrep '.price' -p --parent 1 testdata/cards.html`
- `cssgrep '.more' -C1 testdata/blog.html`
- `cssgrep 'a[href]' -l -r .` ; `cssgrep '.x' -q testdata/blog.html; echo $?`
