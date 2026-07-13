# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.8.0] - 2026-07-13

### Changed
- The `-n` locator is now colon-separated from the text —
  `file:line:col:text` instead of `file:line:col text` — matching grep's
  separator and making the output byte-compatible with `rg --vimgrep`. Vim
  users can use the standard `grepformat=%f:%l:%c:%m` (docs updated); scripts
  parsing the old space-separated form need the one-character change.

## [1.7.0] - 2026-07-12

### Added
- `-p` output is syntax-highlighted when color is on: tag names, attribute
  names, attribute values and comments each get a color, and with
  `--parent -p` the matched node's region stays wrapped in unbroken match
  red on top of it. `--color=never` (or piping) keeps the plain output.

## [1.6.0] - 2026-07-12

### Added
- Embedded HTML in JS/TS: files with `.js`/`.mjs`/`.cjs`/`.jsx`/`.ts`/`.mts`/
  `.cts`/`.tsx` extensions are searched for HTML inside template literals
  (tagged or not), with locators pointing into the host file — quickfix jumps
  straight to the match inside `` html`…` ``. `${…}` holes match as
  whitespace but display as the original source; each literal parses
  independently, so an unclosed tag in one can't leak into the next. Under
  `-r`, opt in with `--ext js,ts`. JSX is not extracted (it isn't HTML).

## [1.5.0] - 2026-07-12

### Added
- `--json` records now include `attribs`, the matched element's attribute
  object (names lowercased by the parser) — the same field the library's
  `Match` exposes, so scraping pipelines get attribute data without a second
  pass (e.g. `jq -r .attribs.href`).

## [1.4.0] - 2026-07-07

### Fixed
- Large result sets no longer crash with `RangeError: Invalid string length`
  (exit 1, zero output): output is written in byte-bounded chunks instead of
  one giant join. Observed with 40k matches on an 8 MB minified line.
- Emitting many matches on one physical line was quadratic (two O(line)
  scans per match); the same 40k-locator case dropped from 9.4 s to 0.4 s.
  Found by the new `npm run bench` harness.

### Changed
- grep parity: without `-n`, a matching line now prints once, however many
  matches sit on it. With `-n` there is still one record per match, each
  with its own `line:col` locator.
- Startup no longer loads the pretty-printing dependencies unless `-p` is
  used (43.4 → 37.9 ms measured), and zero-match files skip the line index.

## [1.3.0] - 2026-07-07

### Added
- `--watch`: re-run the search whenever a watched file changes (native
  recursive file events, no polling; debounced; every rerun repeats the full
  walk so new files appear under the same include/ignore rules). Output
  adapts like `--color=auto`: a TTY clears and reprints (`--no-clear` to
  append instead), pipes get `== HH:MM:SS ==` run separators, and `--json`
  becomes an NDJSON stream of `{"event":"run",…}` records followed by
  matches. Ctrl-C exits 0.
- Rewrite mode: `--add-class`, `--remove-class`, `--set-attr k=v`,
  `--remove-attr` and `--rename-tag` edit the matched elements instead of
  reporting them. Byte-splice fidelity: only the matched tags' bytes change.
  A single input prints the rewritten document to stdout; `--diff` emits a
  git-apply-able unified diff (required for multiple files) — cssgrep never
  writes a file. Ops compose in a fixed order regardless of argv order;
  non-UTF-8 input is refused. Also exposed to library consumers as
  `doc.transform(selector, ops)` returning `{ html, edits }`.
- `-e`/`--selector [label=]<sel>` (repeatable): search several selectors in
  one pass, each match tagged `[label]` in line mode and carrying a `label`
  field in `--json`. Unlabeled selectors are tagged with their own text.
  Matches merge in document order; `-m`/`-M` cap the merged stream. With
  `-e`, positional arguments are always file paths, like `grep -e`.
- An "Inverting matches" section in the README and man page: `:not()` (with
  selector lists) and `:has()` recipes covering what grep's `-v` does, pinned
  by tests. Decided against adding a `-v` flag — the selector already names
  the inversion universe; see `ROADMAP.md` Phase 7 for the analysis.
- `-v`/`--invert-match` now fail with a message pointing at the `:not()`/
  `:has()` recipes (still exit 2), instead of a generic "unknown option".
- Library API: `require('cssgrep')` now exposes `parse(html)`, which parses
  once (source positions, cached line index) and returns a document handle;
  `doc.search(selector, opts)` runs any number of selectors against the same
  tree — the CLI is built on it, so `-e` never re-parses. Matches are plain
  objects with source positions (`start`/`end` offsets, 1-based `line`,
  byte-accurate `col`, `tag`, `attribs`, `html`, `text` — the last four lazy)
  plus the raw htmlparser2 element as a non-enumerable `node` escape hatch,
  so records `JSON.stringify` cleanly. `opts.parent` mirrors the CLI's
  `--parent`. TypeScript definitions ship as `index.d.ts`.

### Changed
- The package was split into `lib.js` (library) and `cli.js` (the `cssgrep`
  bin); `index.js` is gone. Requiring the package no longer executes the CLI.
  The CLI itself is unchanged.

## [1.2.0] - 2026-07-02

### Added
- `-S`/`--follow` to follow symbolic links while recursing with `-r`
  (skipped by default). Cycle-safe: each physical directory is visited once.

### Fixed
- Large result sets are no longer truncated when stdout is a pipe (the process
  exited before async pipe writes had flushed).
- Columns (`-n`, `-A`/`-B`/`-C`, `--json`) now count bytes — what vim's
  `grepformat %c` expects — instead of UTF-16 code units, so non-ASCII text
  before a match no longer skews the locator.
- A value-taking option with no value (e.g. a trailing `--ignore` or `--attr`)
  now fails cleanly with exit 2 instead of crashing or being silently ignored.
- `**/` in globs stops at path-segment boundaries: `--include '**/foo.html'`
  no longer matches `barfoo.html`.
- `--attr` matches attribute names case-insensitively (the parser lowercases
  them), and exits 1 when every match was skipped for lacking the attribute.
- `-w`/`--max-width` no longer cuts an astral character in half.
- Binary detection now also applies to standard input.
- Slash-containing globs (e.g. `--include 'src/*.html'`) now match on Windows:
  paths are normalized to `/` separators before glob matching.
- Recursive walks visit directory entries in sorted order, so output order is
  deterministic across platforms.

### Changed
- Bare `--color` now means `auto`, matching GNU grep (was `always`).
- `-c` prints zero counts (`file:0`, or a lone `0` for a single input),
  matching grep.

## [1.1.0] - 2026-07-02

### Added
- `-H`/`--with-filename` and `--no-filename` to force the `file:` prefix on or off.
- `-s`/`--no-messages` to suppress errors for unreadable or missing files.
- `--include`/`--exclude` file globs with brace alternation (`{a,b,c}`).
  `--exclude` is an alias of `--ignore`; `--include` replaces the `--ext` filter.
- `--max-depth <n>` to cap `-r` recursion depth.
- Automatic skipping of binary files (NUL byte / control-byte heuristic), with a
  note on stderr suppressible by `-s`/`-q`.

### Changed
- CI now runs on Linux, macOS and Windows across Node 20 and 22.
- Releases publish to npm with provenance and smoke-test the built binary.

## [1.0.0] - 2026-06-29

### Added
- Initial release: match a CSS selector against HTML and print each hit
  grep-style, with byte-accurate `line:col` via `-n` (works on minified HTML).
- Recursive search: `-r`/`--recursive`, `--ext`, `-i`/`--ignore`, `--ignore-file`.
- Print modes: default line, `-p`/`--print`, `--attr`, `--text`, `--json`.
- `--parent <n>` structural context; line context `-A`/`-B`/`-C`.
- Limits `-m`/`--max-count`, `-M`/`--max-total`; aggregates `-c`, `-l`/`-L`, `-q`.
- `-0`/`--null`, `--color`, `-w`/`--max-width`, `-V`/`--version`.
- Standalone binaries (Bun, Node SEA), shell completions, and a man page.

[Unreleased]: https://github.com/msbatarce/cssgrep/compare/v1.8.0...HEAD
[1.8.0]: https://github.com/msbatarce/cssgrep/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/msbatarce/cssgrep/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/msbatarce/cssgrep/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/msbatarce/cssgrep/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/msbatarce/cssgrep/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/msbatarce/cssgrep/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/msbatarce/cssgrep/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/msbatarce/cssgrep/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/msbatarce/cssgrep/releases/tag/v1.0.0
