# cssgrep

[![npm](https://img.shields.io/npm/v/cssgrep.svg)](https://www.npmjs.com/package/cssgrep)
[![test](https://github.com/msbatarce/cssgrep/actions/workflows/test.yml/badge.svg)](https://github.com/msbatarce/cssgrep/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/cssgrep.svg)](LICENSE)

Search HTML by CSS selector and print each match, grep-style — add `-n` to
report it as `file:line:col`.

Unlike most HTML query tools, `cssgrep` tracks the **source position** of every
matched node — so it works even on minified, single-line HTML, and (with `-n`)
its output plugs straight into grep-aware editors.

## Install

From npm (requires Node ≥ 20.19):

```sh
npm install -g cssgrep
```

Or from a clone, for development:

```sh
npm install        # install deps
npm link           # put `cssgrep` on your PATH (optional)
```

Check the installed version with `cssgrep --version`. A global install also
puts a man page on your `MANPATH`, so `man cssgrep` works; from a clone, read it
with `man ./man/cssgrep.1`.

### Standalone binary (no Node required)

Each release ships self-contained executables — download the one for your
platform, `chmod +x`, and run it; no Node install needed. To build them yourself
you need [Bun](https://bun.sh) (used only as a build tool — the project still
runs on plain Node):

```sh
bun --version           # https://bun.sh
npm run build:binaries  # writes dist/cssgrep-{linux,darwin}-{x64,arm64} and -windows-x64.exe
```

Bun cross-compiles all targets from one machine, so this is what CI uses to
produce release artifacts. `npm run build:linux-x64` (etc.) builds a single
target.

If you'd rather not install Bun, `npm run build:sea` produces a binary using
[Node's built-in SEA](https://nodejs.org/api/single-executable-applications.html)
(needs the `esbuild`/`postject` devDependencies). The catch: Node SEA **cannot
cross-compile** — it embeds the node you run it with, so you only get a binary
for the current OS and architecture. Bun is the better choice for multi-platform
releases.

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
| `--max-depth <n>` | Limit `-r` recursion depth (`1` = the given directory only, no subdirectories). |
| `--ext <list>` | Extensions to scan with `-r` (default `html,htm`). Value attaches with `=`: `--ext htm` or `--ext=htm`. |
| `--include <glob>` | Only search files whose name/path matches `<glob>` while recursing (repeatable). Replaces `--ext` — the two can't be combined. e.g. `--include '*.{html,htm,xhtml}'`. |
| `-i`, `--ignore <glob>` | Skip files/dirs matching `<glob>` while recursing (repeatable). `node_modules`, `*.min.html`, `build/` (dir-only), or path globs like `src/vendor/**`. |
| `--exclude <glob>` | Alias for `--ignore` (grep's name for the same thing). |
| `--ignore-file <path>` | Load ignore globs from a file, one per line (`#` comments and blank lines ignored) — like a `.gitignore`. |
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
| `-M`, `--max-total <n>` | Stop after `n` matches in total across all files. |
| `-c`, `--count` | Print only the match count (per file when relevant). |
| `-l`, `--files-with-matches` | Print only the names of files that contain a match. |
| `-L`, `--files-without-match` | Print only the names of files with no match. |
| `-q`, `--quiet` | Print nothing; exit `0` on the first match, `1` if none. Stops early. |
| `-s`, `--no-messages` | Suppress error messages for unreadable or missing files (handy with `-r`). |
| `-0`, `--null` | Output a NUL after each file name instead of `:` (or, with `-l`/`-L`, instead of the newline) — pipe to `xargs -0`. |
| `-H`, `--with-filename` | Always print the `file:` prefix, even for a single file or stdin. |
| `--no-filename` | Never print the `file:` prefix, even when searching multiple files. |
| `--color[=<when>]` | Colorize output: `auto` (default — color only when stdout is a terminal), `always`, or `never`. A bare `--color` means `always`. |
| `-h`, `--help` | Show help. |
| `-V`, `--version` | Print the version and exit. |

Boolean short flags can be combined into one token (`-rn` is `-r -n`), and a
value-taking flag may close such a cluster (`-rnw100`).

Globs for `--include`/`--ignore`/`--exclude` support `*` (within a path
segment), `**` (across `/`), `?` (one non-slash char), and brace alternation
like `*.{html,htm}`. A trailing `/` matches directories only; a pattern with a
`/` matches against the path, otherwise the basename — gitignore-flavored.

Binary files are detected (a NUL byte or a high ratio of control bytes in the
first 8 KB) and skipped with a note on stderr — parsing them as HTML is never
useful. Suppress the note with `-s` (or `-q`).

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
cssgrep 'a[href^="https"]' testdata/links.html
cssgrep 'div.card > h2' -r src/ -w 100
cssgrep 'form input[required]' templates/*.html -c
curl -s https://example.com | cssgrep 'p a'

# extraction — print attribute values or text instead of source lines
cssgrep 'a' --attr href testdata/links.html   # every link target
cssgrep 'h1, h2' --text -r src/               # all heading text
cssgrep 'img' -l -r .                          # files that contain an <img>

# structural context — show the container the match lives in
cssgrep '.price' -p --parent 1 testdata/cards.html  # pretty-print each price's card

# ignore noise while recursing
cssgrep 'script' -r . -i node_modules -i '*.min.html'
cssgrep 'a' -r . --ignore-file .gitignore
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

## Shell completions

Completions for every flag ship in [`completions/`](completions/). Install the
one for your shell (a global install puts them under
`"$(npm root -g)/cssgrep/completions/"`):

```sh
# bash — source it, or copy to your bash-completion completions dir as `cssgrep`
source completions/cssgrep.bash

# zsh — drop `_cssgrep` onto your $fpath, then run compinit
cp completions/_cssgrep ~/.zsh/completions/   # a dir on your $fpath

# fish
cp completions/cssgrep.fish ~/.config/fish/completions/
```

(The completions are hand-maintained; keep them in step with `--help` if you add
a flag.)

## How it works

- [`htmlparser2`](https://github.com/fb55/htmlparser2) parses with
  `withStartIndices`, recording each node's byte offset into the source.
- [`css-select`](https://github.com/fb55/css-select) matches the selector
  against that DOM (the same engine cheerio uses).
- Offsets are converted to 1-based `line:col` via a precomputed line index;
  `col` points at the opening `<` of the matched tag and counts *bytes* — what
  vim's `grepformat` `%c` expects — so multibyte UTF-8 text earlier on the line
  doesn't skew the cursor.
