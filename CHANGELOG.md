# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/msbatarce/cssgrep/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/msbatarce/cssgrep/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/msbatarce/cssgrep/releases/tag/v1.0.0
