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

Like `grep`, each matching line is printed on its own, once — however many
matches sit on it. With `-n` there is one record *per match*, each with its
own `line:col` locator (that per-match precision is the point of the tool). A
`file:` prefix is added when searching multiple files:

```
{line contents}                         # default; stdin or single file
{file}:{line contents}                  # default; multiple files
{line}:{col} {line contents}            # -n; stdin or single file
{file}:{line}:{col} {line contents}     # -n; multiple files
```

### Options

| Flag | Description |
|------|-------------|
| `-e`, `--selector <[label=]sel>` | Add a selector (repeatable). Matches from all `-e` selectors merge in document order, each tagged `[label]` (default label: the selector text). With `-e`, every positional argument is a file path, like `grep -e`. See [Multiple selectors](#multiple-selectors--e). |
| `-r`, `--recursive` | Recurse into directory arguments (defaults to `.` if none given). |
| `--max-depth <n>` | Limit `-r` recursion depth (`1` = the given directory only, no subdirectories). |
| `--ext <list>` | Extensions to scan with `-r` (default `html,htm`). Value attaches with `=`: `--ext htm` or `--ext=htm`. |
| `--include <glob>` | Only search files whose name/path matches `<glob>` while recursing (repeatable). Replaces `--ext` — the two can't be combined. e.g. `--include '*.{html,htm,xhtml}'`. |
| `-i`, `--ignore <glob>` | Skip files/dirs matching `<glob>` while recursing (repeatable). `node_modules`, `*.min.html`, `build/` (dir-only), or path globs like `src/vendor/**`. |
| `--exclude <glob>` | Alias for `--ignore` (grep's name for the same thing). |
| `--ignore-file <path>` | Load ignore globs from a file, one per line (`#` comments and blank lines ignored) — like a `.gitignore`. |
| `-S`, `--follow` | Follow symbolic links while recursing with `-r` (they are skipped by default). Each physical directory is visited once, so symlink cycles are safe. |
| `-n`, `--line-number` | Prefix each match with its `line:col` locator. Mutually exclusive with `-c` and `-p`. |
| `-p`, `--print` | Pretty-print the matched node's HTML, re-indented from scratch (works on minified input). No `line:col` locator is shown. |
| `--attr <name>` | Print the value of attribute `<name>` for each match (nodes without it are skipped; if every match is skipped the exit status is 1). The name is matched case-insensitively. Honors `-n` and `-w`. |
| `--text` | Print the matched node's text content, whitespace collapsed. Honors `-n` and `-w`. |
| `--json` | Print one JSON object per match (NDJSON), with `file`, `line`, `col`, `attribs` (the element's attributes, names lowercased), `html`, `text` — plus `label` when `-e` is used. |
| `--parent <n>` | Report the `n`-th element ancestor of each match instead of the match itself (de-duplicated). Pairs well with `-p`. |
| `-w`, `--max-width <n>` | Truncate the shown line to `n` columns (adds `…`). Value attaches or follows: `-w100`, `-w 100`, `--max-width=100`. |
| `-A`, `--after-context <n>` | Print `n` source lines after each match. |
| `-B`, `--before-context <n>` | Print `n` source lines before each match. |
| `-C`, `--context <n>` | Print `n` source lines before and after each match. |
| `-m`, `--max-count <n>` | Stop after `n` matches per file (caps `-c` too). |
| `-M`, `--max-total <n>` | Stop after `n` matches in total across all files. The budget counts matches, not files — combined with `-l`/`-L`, scanning stops once `n` matches have been seen, which can cut the file list short. |
| `-c`, `--count` | Print only the match count (per file when relevant, zeros included — `file:0`, like grep). |
| `-l`, `--files-with-matches` | Print only the names of files that contain a match. |
| `-L`, `--files-without-match` | Print only the names of files with no match. |
| `-q`, `--quiet` | Print nothing; exit `0` on the first match, `1` if none. Stops early. |
| `-s`, `--no-messages` | Suppress error messages for unreadable or missing files (handy with `-r`). |
| `-0`, `--null` | Output a NUL after each file name instead of `:` (or, with `-l`/`-L`, instead of the newline) — pipe to `xargs -0`. |
| `-H`, `--with-filename` | Always print the `file:` prefix, even for a single file or stdin. |
| `--no-filename` | Never print the `file:` prefix, even when searching multiple files. |
| `--color[=<when>]` | Colorize output: `auto` (default — color only when stdout is a terminal), `always`, or `never`. A bare `--color` means `auto`, like grep; use `--color=always` to force color into pipes. |
| `--watch` | Re-run the search whenever a watched file changes. TTY: clear + reprint; pipe: append with `== HH:MM:SS ==` separators; `--json`: NDJSON `{"event":"run",…}` per rerun. Ctrl-C exits 0. See [Watch mode](#watch-mode---watch). |
| `--no-clear` | With `--watch` on a TTY: append instead of clearing the screen. |
| `--add-class <c>` | *Rewrite:* add a class to each matched element. See [Rewriting HTML](#rewriting-html-refactor-ops). |
| `--remove-class <c>` | *Rewrite:* remove a class (the attribute is dropped when emptied). |
| `--set-attr <k=v>` | *Rewrite:* set attribute `k` to `v` (added if missing; value escaped). |
| `--remove-attr <k>` | *Rewrite:* remove attribute `k` (all source occurrences). |
| `--rename-tag <t>` | *Rewrite:* rename the element — its closing tag too, when one exists. |
| `--diff` | Emit a unified diff instead of the rewritten document; required for multiple files. Apply with `git apply` or `patch`. |
| `-h`, `--help` | Show help. |
| `-V`, `--version` | Print the version and exit. |

Boolean short flags can be combined into one token (`-rn` is `-r -n`), and a
value-taking flag may close such a cluster (`-rnw100`).

Globs for `--include`/`--ignore`/`--exclude` support `*` (within a path
segment), `**` (across `/`), `?` (one non-slash char), and brace alternation
like `*.{html,htm}`. A trailing `/` matches directories only; a pattern with a
`/` matches against the path, otherwise the basename — gitignore-flavored.

Binary input is detected (a NUL byte or a high ratio of control bytes in the
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

# multiple labeled selectors — scrape several fields in one pass
cssgrep -e 'title=h1' -e 'price=.card .price' --json page.html

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

### Multiple selectors (`-e`)

Repeatable `-e [label=]<selector>` searches several selectors in one parse
pass and tags each match with which one hit — one command turns a page into
labeled fields:

```sh
$ cssgrep -n -e 'title=h1' -e 'price=.card .price' page.html
3:5 [title] <h1>Widget</h1>
9:12 [price] <span class="price">$4.99</span>

$ cssgrep --json -e 'title=h1' -e 'price=.card .price' page.html
{"file":"page.html","line":3,"col":5,"label":"title","attribs":{},"html":"<h1>Widget</h1>","text":"Widget"}
{"file":"page.html","line":9,"col":12,"label":"price","attribs":{"class":"price"},"html":"...","text":"$4.99"}
```

The label is anything matching `[A-Za-z_][A-Za-z0-9_-]*` before a `=`; since a
bare `=` is never valid CSS outside `[...]`, there's no ambiguity — `-e
'[href=x]'` is a plain selector. An unlabeled `-e` is tagged with its own
selector text.

Matches from all selectors merge into one document-order stream (a node hit by
two selectors is reported once per selector, in `-e` order), and `-m`/`-M`
budgets cap that merged stream, exactly like grep caps lines regardless of
which pattern matched. Print modes (`--text`, `--attr`, `-p`, `--json`) apply
globally to every selector. With `-e`, positional arguments are always file
paths — like `grep -e`, a mistyped path is reported as unreadable rather than
re-guessed as a selector.

### Watch mode (`--watch`)

`--watch` keeps the search running and re-runs it whenever a watched file
changes — for keeping an eye on generated HTML, or feeding a tool a live
stream of matches:

```sh
cssgrep '.error' --watch -rn build/        # live view: clears and reprints
cssgrep '.error' --watch -r --json build/ | your-tool   # NDJSON event feed
```

Output adapts to where it goes, like `--color=auto`: on a terminal each run
clears the screen and reprints (pass `--no-clear` to append instead — handy
in tmux scrollback); piped output never contains escape codes and appends
each run after a `== HH:MM:SS <changed file> ==` separator; with `--json`,
each rerun emits `{"event":"run","changed":…,"matches":n}` followed by the
usual match records.

Every rerun repeats the full directory walk, so newly created files are
picked up (and deleted ones dropped) under exactly the same
`--include`/`--ignore`/`--ext` rules as a fresh invocation. Change bursts are
debounced. Watching uses the OS's native file events (no polling), which can
be unreliable on network or virtual filesystems. `--watch` needs file or
directory arguments (stdin can't be watched), can't be combined with `-q` or
the rewrite ops, and runs until Ctrl-C (exit status 0, like `watch(1)`).

### Rewriting HTML (refactor ops)

The same selector engine can *edit* what it matches. Five ops — repeatable and
freely combined — rewrite each matched element's tag in place:

```sh
$ cssgrep '.old' --remove-class old --add-class fresh page.html   # rewritten doc → stdout
$ cssgrep 'b' --rename-tag strong -r src/ --diff                  # unified diff for many files
$ cssgrep 'b' --rename-tag strong -r src/ --diff | git apply      # …review, then apply
```

The fidelity contract: **only the matched tags' bytes change.** Matching runs
once against the original document, then edits are byte-splices — quoting,
entities, whitespace and formatting everywhere else pass through untouched
(the edited attribute itself is normalized to `name="value"`). Ops compose in
a fixed order — rename → remove-attr → set-attr → remove-class → add-class —
so results never depend on argument order. `--rename-tag` edits the closing
tag only when one explicitly exists (voids like `<img>`, self-closing `<x/>`
and implied closes like `<li>` are handled). `--parent` composes: `.price
--add-class sale --parent 1` tags the container.

cssgrep never writes a file: a single input prints the rewritten document to
stdout; `--diff` (required for multiple files) emits a git-apply-able unified
diff, so applying is a reviewable, revertable `git apply`/`patch` step. Input
that isn't valid UTF-8 is refused (exit 2) — a rewriter must never corrupt
bytes it didn't edit. Exit status: `0` if anything was edited, `1` if nothing
matched, `2` on error.

Rewrite is its own mode: it can't be combined with the print
(`-n`/`-p`/`--attr`/`--text`/`--json`), aggregate (`-c`/`-l`/`-L`/`-q`),
context, `-m`/`-M`, `-w`, `-0` or `-e` flags.

The same operation is available to library consumers as
`doc.transform(selector, ops)` — see [Library usage](#library-usage).

### Inverting matches (why there's no `-v`)

grep needs `-v` because a regex can't say "lines *not* matching". CSS can:
`:not()` — including full complex selectors and selector lists, plus `:has()`
for descendant conditions — expresses every inversion directly in the
selector, scoped to the elements you actually care about:

```sh
cssgrep 'img:not([alt])' -rn .          # accessibility: images missing alt text
cssgrep 'div.card:not(:has(a))' page.html   # cards that contain no link
cssgrep 'a:not(nav a, footer a)' page.html  # links outside chrome
cssgrep 'input:not([type=hidden])' -c form.html  # count the visible inputs
```

A flag-level `-v` would need its own answer to "*which* non-matching
elements?" — bare inversion (`:not(a)`) matches nearly every element in the
document — so the selector, which already names the universe on the left of
`:not()`, is both shorter and standard CSS. For whole files without a match,
use `-L`.

Typing `-v` or `--invert-match` out of grep habit fails with exit 2 and a
message pointing back to these recipes, rather than a bare "unknown option".

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

## Library usage

The engine is also a programmatic API — `require('cssgrep')` gives you
`parse()` (the CLI is a separate entry point built on it, so requiring the
package never runs it):

```js
const { parse } = require('cssgrep');

const doc = parse('<div class="card"><a href="/x">go</a></div>'); // parse once
doc.search('.card a');                                     // …query many times
// [{
//   start: 18, end: 39,        // offsets into the input: doc.html.slice(start, end)
//   line: 1, col: 19,          // 1-based; col counts bytes, like the CLI's -n
//   tag: 'a',
//   attribs: { href: '/x' },
//   html: '<a href="/x">go</a>',
//   text: 'go',
//   node: [Element],           // raw htmlparser2 element (advanced, unstable)
// }]
doc.search('a', { parent: 1 });    // same tree, no re-parse
```

`parse(html)` takes an HTML **string** (file discovery, stdin and binary
detection are CLI concerns) and pays the parse and line index once; each
`doc.search(selector, opts)` is then just a selector run over the same tree —
this is what the CLI's `-e` uses, so multiple selectors never re-parse.
Matches come back in DOM order; `opts.parent` re-targets each to its n-th
element ancestor, deduplicated — the CLI's `--parent`. `line`/`col`/`html`/
`text` are lazy (computed on first read, and by `JSON.stringify`; the circular
`node` reference stays out of serialization). `parse` throws on non-string
input, `search` on a selector [css-select](https://github.com/fb55/css-select)
cannot parse. TypeScript types ship with the package (`index.d.ts`).

Every match's `html` is the exact source slice, so offsets stay byte-faithful
even on minified input — the same position tracking the CLI uses.

The rewrite mode is exposed as `doc.transform(selector, ops)`:

```js
const { html, edits } = doc.transform('.old', {
  removeClass: 'old', addClass: 'fresh',      // also: renameTag, setAttr,
});                                           // removeAttr, parent
// html  — the rewritten document (bytes outside the edits untouched)
// edits — [{ start, end, before, after }] splice records, document order
```

## How it works

- [`htmlparser2`](https://github.com/fb55/htmlparser2) parses with
  `withStartIndices`, recording each node's byte offset into the source.
- [`css-select`](https://github.com/fb55/css-select) matches the selector
  against that DOM (the same engine cheerio uses).
- Offsets are converted to 1-based `line:col` via a precomputed line index;
  `col` points at the opening `<` of the matched tag and counts *bytes* — what
  vim's `grepformat` `%c` expects — so multibyte UTF-8 text earlier on the line
  doesn't skew the cursor.
