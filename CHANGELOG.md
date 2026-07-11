# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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

[Unreleased]: https://github.com/msbatarce/cssgrep/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/msbatarce/cssgrep/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/msbatarce/cssgrep/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/msbatarce/cssgrep/releases/tag/v1.0.0
