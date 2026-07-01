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
| `--ext <list>` | Extensions to scan with `-r` (default `html,htm`). Value attaches with `=`: `--ext htm` or `--ext=htm`. |
| `-n`, `--line-number` | Prefix each match with its `line:col` locator. Mutually exclusive with `-c` and `-p`. |
| `-p`, `--print` | Pretty-print the matched node's HTML, re-indented from scratch (works on minified input). No `line:col` locator is shown. |
| `--attr <name>` | Print the value of attribute `<name>` for each match (nodes without it are skipped). Honors `-n` and `-w`. |
| `--text` | Print the matched node's text content, whitespace collapsed. Honors `-n` and `-w`. |
| `--json` | Print one JSON object per match (NDJSON), with `file`, `line`, `col`, `html`, `text`. |
| `--parent <n>` | Report the `n`-th element ancestor of each match instead of the match itself (de-duplicated). Pairs well with `-p`. |
| `-w`, `--max-width <n>` | Truncate the shown line to `n` columns (adds `…`). Value attaches or follows: `-w100`, `-w 100`, `--max-width=100`. |
| `-A`, `--after-context <n>` | Print `n` source lines after each match. |
| `-B`, `--before-context <n>` | Print `n` source lines before each match. |
| `-C`, `--context <n>` | Print `n` source lines before and after each match. |
| `-m`, `--max-count <n>` | Stop after `n` matches per file (caps `-c` too). |
| `-c`, `--count` | Print only the match count (per file when relevant). |
| `-l`, `--files-with-matches` | Print only the names of files that contain a match. |
| `-L`, `--files-without-match` | Print only the names of files with no match. |
| `-q`, `--quiet` | Print nothing; exit `0` on the first match, `1` if none. Stops early. |
| `-0`, `--null` | Output a NUL after each file name instead of `:` (or, with `-l`/`-L`, instead of the newline) — pipe to `xargs -0`. |
| `--color[=<when>]` | Colorize output: `auto` (default — color only when stdout is a terminal), `always`, or `never`. A bare `--color` means `always`. |
| `-h`, `--help` | Show help. |

Boolean short flags can be combined into one token (`-rn` is `-r -n`), and a
value-taking flag may close such a cluster (`-rnw100`).

When coloring is on, the matched node is highlighted within its line (grep's
bold-red); the `file:` prefix and `line:col` locator get their own colors
(magenta and green, like grep). Plain `-p` prints no color (the whole block is
the match), but `-p --parent <n>` highlights the original matched node inside
the printed container, so you can see what matched within its surroundings.

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

# extraction — print attribute values or text instead of source lines
cssgrep 'a' --attr href index.html        # every link target
cssgrep 'h1, h2' --text -r src/           # all heading text
cssgrep 'img' -l -r .                      # files that contain an <img>

# structural context — show the container the match lives in
cssgrep '.price' -p --parent 2 page.html  # pretty-print each price's grandparent
```

### Structural context (`--parent`)

`--parent <n>` re-targets each match to its `n`-th element ancestor before
printing — structural context that line-based `-A`/`-B` can't express. Shared
ancestors are de-duplicated, so `cssgrep '.price' --parent 1 -p` prints each
containing card once. It composes with every print mode (`-p`, `--attr`,
`--text`, `--json`, or the default line output).

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
