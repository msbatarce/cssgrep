# CLAUDE.md

Guidance for working in this repo. Keep it current as the project evolves.

## What this is

`cssgrep` — grep for HTML by CSS selector. It matches a selector against parsed
HTML and reports each hit grep-style. Its distinguishing feature is **source
position tracking**: it records each matched node's byte offset, so `line:col`
output works even on minified, single-line HTML, and the output plugs straight
into grep-aware editors (vim `grepprg`).

Two files, no build step: `lib.js` (the library — `require('cssgrep')` exposes
`parse()`; types in `index.d.ts`) and `cli.js` (the `cssgrep` bin, a consumer
of the lib).

## Run & test

```sh
npm install     # deps: htmlparser2, css-select, dom-serializer, js-beautify
npm test        # runs test.js — drives the built CLI as a subprocess
node cli.js <selector> [file ...]     # run directly
```

`test.js` is a dependency-free harness: it spawns `cli.js` and asserts on
stdout/exit status, so tests cover parsing + output end-to-end (plus a few
in-process checks of the `lib.js` API). Add a `check(...)` case for every new
behavior. Always run `npm test` before committing.

## Architecture

CLI pipeline: parse args → resolve selector/paths → for each source, parse
HTML, run the selector, format matches.

`lib.js` — the engine (string in, data out; no process/fs concerns):

- `parse(html)` — the public API: parse once (start/end indices, lazy cached
  line index) into a document handle; `doc.search(selector, opts)` then runs
  any number of selectors against the same tree, returning plain-object
  matches (`{start, end, line, col, tag, attribs, html, text, node}` —
  line/col/html/text lazy, `node` non-enumerable). `doc.transform(selector,
  ops)` rewrites matched elements by byte-splicing only their tags, returning
  `{html, edits}` (ops in fixed pipeline order; backed by a small opening-tag
  lexer, since htmlparser2 has no attribute offsets). Throws on bad
  input/selector/ops.
- `lineIndex(src)` / `offsetToPosition(starts, src, off)` — precomputed line
  starts + binary search to turn a byte offset into 1-based `line:col` + the
  line text (strips trailing `\r` for CRLF files).
- `textOf` / `ancestor` / `retarget` — text extraction and `--parent`
  re-targeting, shared with the CLI. Exported but internal (not in `index.d.ts`).

`cli.js` — the `cssgrep` bin (imports the helpers above from `./lib.js`):

- `parseArgs(argv)` — getopt-style parser. Returns an `opts` object and resolves
  derived state (e.g. `opts.colorOn`). All option validation lives here.
- `resolveSelectorAndPaths(opts)` — the selector and paths share positional
  slots; this splits them by what exists on disk, so argument order doesn't
  matter (important for vim's `grepprg`).
- `truncate(text, w)` / `renderText(pos, off, nodeEnd, opts)` — width limiting
  and in-line match highlighting (color applied to truncated text, never to the
  ellipsis or escape sequences).
- `prettyPrint(el)` — re-indents a node's HTML via dom-serializer + js-beautify.
- `searchSource(src, label, opts, out)` — the core: `parseDocument` (with
  start/end indices) → `selectAll` → emit per the active output mode.
- `walk` / `readStdin` / `main` — file discovery, stdin, orchestration.

## Conventions

- **Grep-faithful by default.** Output format, exit codes (`0` match / `1` none
  / `2` error), and flag semantics mirror `grep`/`ripgrep` wherever sensible.
  Default output is just the matched line; `-n` adds the `line:col` locator.
- **Option parsing is getopt-style.** Short flags cluster (`-rn`); a value
  attaches (`-w100`) or follows (`-w 100`) and may close a cluster (`-rnw100`);
  long options take a value with `=` or as the next word. New value-taking short
  flags must hook into the cluster loop, not just the `--long` switch.
- **Validate flag combinations in `parseArgs`** and `fail()` with a clear
  message (exit 2). See the output-mode axes below — illegal cross-axis combos
  are rejected there.
- **Keep it dependency-light.** Prefer a small local helper over a new
  dependency (and never rely on a transitive dep that isn't in `package.json`).
- **Update docs with code.** Any new flag must update, in the same change, all
  four doc surfaces: the `USAGE` string in `cli.js`, the options table in
  `README.md`, the man page (`man/cssgrep.1`), and the three completion files
  (`completions/cssgrep.bash`, `completions/_cssgrep`, `completions/cssgrep.fish`).

### Commits

- **One commit per feature.** Each implemented feature (or roadmap phase item)
  is its own self-contained commit — code + tests + docs together, with the
  suite green. Do not batch unrelated features into one commit.
- Write a descriptive message body explaining the *why*, not just the *what*.
- End commit messages with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Only commit when asked, and only after `npm test` passes.

## Output-mode model (design backbone)

New output flags slot into three independent axes (see `ROADMAP.md` for detail):

1. **Target** — which node a match resolves to (the match itself, or an ancestor
   via `--parent`).
2. **Print mode** — what is printed per match (line / `-p` / `--attr` / `--text`
   / `--json`); exactly one, mutually exclusive.
3. **Aggregate** — content-suppressing modes (`-c`, `-l`/`-L`, `-q`); at most one.

When adding an output feature, place it on the right axis and extend the
validation matrix accordingly.

The rewrite ops (`--add-class` etc., `--diff`) are a separate *program mode*,
not a fourth axis: they exclude the print and aggregate axes entirely (only
the Target axis, `--parent`, composes). `rewriteMain` in `cli.js` is that
mode's `main`. `--watch` (`watchMain`) is a *driver* over the normal search:
it re-runs `resolveFiles` + `searchFiles` per (debounced) file event and
adapts its output to TTY/pipe/`--json`; it excludes `-q` and the rewrite ops.

## Roadmap

Planned work is tracked in `ROADMAP.md` (phased; each item is one commit).
