# cssgrep

Search HTML by CSS selector and print each match, grep-style — add `-n` to
report it as `file:line:col`.

Unlike most HTML query tools, `cssgrep` tracks the **source position** of every
matched node — so it works even on minified, single-line HTML, and (with `-n`)
its output plugs straight into grep-aware editors.

## Install

```sh
npm install        # install deps
npm link           # put `cssgrep` on your PATH (optional)
```

Requires Node (see `.nvmrc`).

## Usage

```sh
cssgrep <selector> [file ...]      # search the given files
cssgrep <selector> -r <dir ...>    # recurse directories
cat page.html | cssgrep <selector> # read from stdin
```

Output, one line per match. Like `grep`, the matched line is printed on its own;
a `file:` prefix is added when searching multiple files, and the `line:col`
locator appears only with `-n`:

```
{line contents}                         # default; stdin or single file
{file}:{line contents}                  # default; multiple files
{line}:{col} {line contents}            # -n; stdin or single file
{file}:{line}:{col} {line contents}     # -n; multiple files
```

### Options

| Flag | Description |
|------|-------------|
| `-r`, `--recursive` | Recurse into directory arguments (defaults to `.` if none given). |
| `--ext <list>` | Extensions to scan with `-r` (default `html,htm`). |
| `-n`, `--line-number` | Prefix each match with its `line:col` locator. Mutually exclusive with `-c` and `-p`. |
| `-p`, `--print` | Pretty-print the matched node's HTML, re-indented from scratch (works on minified input). No `line:col` locator is shown. |
| `-w`, `--max-width <n>` | Truncate the shown line to `n` columns (adds `…`). |
| `-c`, `--count` | Print only the match count (per file when relevant). |
| `--color[=<when>]` | Colorize output: `auto` (default — color only when stdout is a terminal), `always`, or `never`. A bare `--color` means `always`. |
| `-h`, `--help` | Show help. |

When coloring is on, the matched node is highlighted within its line (grep's
bold-red); the `file:` prefix and `line:col` locator get their own colors
(magenta and green, like grep). Under `-p` nothing is colored — the node is
lifted out of its line, so there's no in-line match to highlight.

Exit status: `0` if any match was found, `1` if none, `2` on error — same
convention as `grep`.

The selector and paths can appear in any order — `cssgrep -r src 'div.a'` and
`cssgrep 'div.a' -r src` are equivalent. The selector is whichever argument
doesn't name an existing file or directory.

### Examples

```sh
cssgrep 'a[href^="https"]' index.html
cssgrep 'div.card > h2' -r src/ -w 100
cssgrep 'form input[required]' templates/*.html -c
curl -s https://example.com | cssgrep 'p a'
```

## Vim / Neovim integration

The `file:line:col text` format produced by `-n` is `:grep`-compatible. Point
`grepprg` at `cssgrep -n -r` and hits land in the quickfix list:

```vim
set grepprg=cssgrep\ -n\ -r
set grepformat=%f:%l:%c\ %m

" :grep 'div.card' src/   then  :copen
```

For a single buffer's HTML:

```vim
:cexpr system('cssgrep -n ' . shellescape(input('selector> ')) . ' ' . shellescape(expand('%')))
```

## How it works

- [`htmlparser2`](https://github.com/fb55/htmlparser2) parses with
  `withStartIndices`, recording each node's byte offset into the source.
- [`css-select`](https://github.com/fb55/css-select) matches the selector
  against that DOM (the same engine cheerio uses).
- Offsets are converted to 1-based `line:col` via a precomputed line index;
  `col` points at the opening `<` of the matched tag.
