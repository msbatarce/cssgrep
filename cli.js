#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  parse, extractHtmlFragments, lexOpenTag, lineIndex, offsetToPosition,
  lineTextAt, textOf, collapseWs, ancestor,
} = require('./lib.js');

// Files with these extensions are scanned for HTML inside JS/TS template
// literals instead of being parsed as one HTML document (ROADMAP Phase 12).
const EMBEDDED_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const isEmbeddedPath = p => EMBEDDED_EXTS.has(path.extname(p).slice(1).toLowerCase());

// dom-serializer + js-beautify are only needed by -p, and cost ~13 ms of a
// ~43 ms startup (measured, ROADMAP Phase 11) — loaded on first use so the
// grepprg-style hot path never pays for them.
let render = null;
let beautify = null;
function loadPrettyPrinter() {
  if (!render) {
    render = require('dom-serializer').default;
    beautify = require('js-beautify').html;
  }
}

// Single source of truth for the version. A constant rather than a read of
// package.json, so it survives compilation into a standalone binary (Bun
// --compile / Node SEA), where package.json won't sit next to the executable.
// Keep in sync with package.json on release.
const VERSION = '1.7.0';

const USAGE = `cssgrep - search HTML by CSS selector, grep-style.

Usage:
  cssgrep <selector> [file ...]
  cssgrep <selector> -r <dir ...>
  cssgrep -e '[label=]<sel>' [-e ...] [file ...]
  cat file.html | cssgrep <selector>

Output (each matching line once, like grep; with -n, one record per match):
  {line contents}                           (default; stdin or single file)
  {file}:{line contents}                    (default; multiple files)
  {line}:{col} {line contents}              (with -n; stdin or single file)
  {file}:{line}:{col} {line contents}       (with -n; multiple files)

Options:
  -e, --selector <[label=]sel>   Add a selector (repeatable). Matches from all
                         -e selectors merge in document order; each is tagged
                         [label] (default label: the selector text itself).
                         With -e, every positional argument is a file path.
  -r, --recursive        Recurse into directory arguments.
      --max-depth <n>    Limit -r recursion depth (1 = the given dir only).
      --ext <list>       Comma-separated extensions for -r (default: html,htm).
      --include <glob>   Only search files matching <glob> (replaces --ext; repeatable).
  -i, --ignore <glob>    Skip files/dirs matching <glob> when recursing (repeatable).
      --exclude <glob>   Alias for --ignore.
      --ignore-file <path>   Read ignore globs from <path> (one per line, # comments).
  -S, --follow           Follow symbolic links when recursing with -r
                         (default: skip them; loops are detected).
  -n, --line-number      Prefix each match with its line:col (excludes -c, -p).
  -p, --print            Pretty-print the matched node's HTML, syntax-
                         highlighted when color is on.
      --attr <name>      Print the value of attribute <name> (skips nodes without it).
      --text             Print the matched node's text content (whitespace collapsed).
      --json             Print one JSON record per match (NDJSON: file,line,col,
                         attribs,html,text; plus label with -e).
      --parent <n>       Report the n-th ancestor of each match instead (dedup'd).
  -w, --max-width <n>    Truncate the shown line to <n> columns (ellipsis added).
  -A, --after-context <n>    Print <n> source lines after each match.
  -B, --before-context <n>   Print <n> source lines before each match.
  -C, --context <n>          Print <n> source lines before and after each match.
  -m, --max-count <n>    Stop after <n> matches per file.
  -M, --max-total <n>    Stop after <n> matches in total (across all files).
  -c, --count            Print only a count of matches (per file when
                         relevant, zeros included, like grep).
  -l, --files-with-matches   Print only the names of files that have a match.
  -L, --files-without-match  Print only the names of files with no match.
  -q, --quiet            Print nothing; exit 0 on first match, 1 if none.
  -s, --no-messages      Suppress error messages for unreadable/missing files.
  -0, --null             Separate the file name with a NUL byte (for xargs -0).
  -H, --with-filename    Always print the file name prefix (even for one file).
      --no-filename      Never print the file name prefix (even for many files).
      --color[=<when>]   Colorize output: auto (default, also what a bare
                         --color means, like grep), always or never.
      --watch            Re-run the search whenever a watched file changes
                         (requires paths; excludes -q and the rewrite ops).
                         On a TTY the screen is cleared and results reprinted;
                         piped output appends each run after a == HH:MM:SS ==
                         separator; with --json each run emits an NDJSON
                         {"event":"run",...} record followed by the matches.
                         Exit with Ctrl-C (status 0).
      --no-clear         With --watch on a TTY: append instead of clearing.
  -h, --help             Show this help.
  -V, --version          Show version and exit.

Rewrite (a separate mode: excludes -n/-p/--attr/--text/--json, -c/-l/-L/-q,
-A/-B/-C, -m/-M, -w, -0 and -e; composes with --parent):
      --add-class <c>    Add a class to each matched element.
      --remove-class <c> Remove a class (attribute dropped when emptied).
      --set-attr <k=v>   Set attribute k to v (added if missing).
      --remove-attr <k>  Remove attribute k.
      --rename-tag <t>   Rename the element (and its closing tag, if present).
      --diff             Emit a unified diff instead of the document; required
                         for multiple files. Apply with git apply / patch.

A single input prints the rewritten document to stdout. Only the matched tags'
bytes change; ops compose as rename -> remove-attr -> set-attr -> remove-class
-> add-class regardless of argument order. Exit: 0 edits, 1 none, 2 error.

Short flags combine (-rn) and a value attaches to its flag (-w100) or follows it
(-w 100); a value-taking flag may close a cluster (-rnw100). Long options take a
value with = or as the next word (--max-width=100, --ext htm).

Globs (--include/--ignore/--exclude) support *, ** (crosses /), ?, and brace
alternation like *.{html,htm}.

JS/TS files (.js .mjs .cjs .jsx .ts .mts .cts .tsx) are searched for HTML
inside template literals: each markup-looking \`...\` is parsed on its own,
\${...} holes match as whitespace, and locators point into the host file
(with -r, add the extensions via --ext js,ts). Rewrite ops don't apply there.

Exit status: 0 if any match was found, 1 if none, 2 on error.`;

function fail(msg) {
  process.stderr.write(`cssgrep: ${msg}\n`);
  process.exit(2);
}

// grep's most predictable stumble: there is no invert-match here, because CSS
// expresses inversion in the selector itself. Teach instead of just rejecting.
function failInvert(flag) {
  fail(`${flag}: there is no invert-match — CSS expresses inversion in the ` +
    `selector, e.g. 'img:not([alt])' or 'div:not(:has(a))'; see man cssgrep`);
}

// ANSI SGR codes matching grep's default scheme: bold-red match, magenta
// filename, green line/col numbers, cyan separators. The [label] tag from -e
// has no grep counterpart; yellow keeps it distinct from all of the above.
// The last four paint -p's syntax highlighting (tag names, attribute names,
// attribute values, comments/doctypes) — distinct from match red, which
// always wins inside a --parent -p match region.
const COLORS = {
  match: '1;31',
  file: '35',
  line: '32',
  sep: '36',
  label: '33',
  tag: '1;34',
  attr: '36',
  value: '32',
  comment: '90',
};

function paint(code, str) {
  return `\x1b[${code}m${str}\x1b[0m`;
}

function parseArgs(argv) {
  const opts = {
    selector: null,
    selectors: [],
    positionals: [],
    paths: [],
    recursive: false,
    follow: false,
    exts: ['html', 'htm'],
    extGiven: false,
    maxDepth: 0,
    lineNumber: false,
    print: false,
    maxWidth: 0,
    maxCount: 0,
    maxTotal: 0,
    count: false,
    filesWithMatches: false,
    filesWithoutMatch: false,
    quiet: false,
    attr: null,
    text: false,
    json: false,
    nul: false,
    parent: 0,
    before: 0,
    after: 0,
    ignore: [],
    include: [],
    withFilename: false,
    noFilename: false,
    noMessages: false,
    color: 'auto',
    rewrite: { renameTag: null, removeAttr: [], setAttr: {}, removeClass: [], addClass: [] },
    diff: false,
    watch: false,
    noClear: false,
  };
  const setExts = v => {
    opts.extGiven = true;
    opts.exts = (v || '').split(',').map(s => s.trim().replace(/^\./, '')).filter(Boolean);
  };
  const boundedInt = (v, what, min) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < min) fail(`invalid ${what} value`);
    return n;
  };
  const positiveInt = (v, what) => boundedInt(v, what, 1);
  const setMaxWidth = v => { opts.maxWidth = positiveInt(v, '--max-width'); };
  const setMaxCount = v => { opts.maxCount = positiveInt(v, '--max-count'); };
  const setMaxTotal = v => { opts.maxTotal = positiveInt(v, '--max-total'); };
  const setMaxDepth = v => { opts.maxDepth = positiveInt(v, '--max-depth'); };
  const setParent = v => { opts.parent = positiveInt(v, '--parent'); };
  const setAfter = v => { opts.after = boundedInt(v, '--after-context', 0); };
  const setBefore = v => { opts.before = boundedInt(v, '--before-context', 0); };
  const setContext = v => { opts.after = opts.before = boundedInt(v, '--context', 0); };
  // -e [label=]<selector>. A `=` outside brackets never begins a *working*
  // selector (css-what tokenizes `a=b` as an unmatchable tag named `=b`), so a
  // leading identifier + `=` is unambiguously a label. Unlabeled selectors are
  // tagged with their own text, so [label] and the --json `label` field are
  // always present when -e is used.
  const addSelector = v => {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)=([\s\S]+)$/.exec(v);
    if (m) opts.selectors.push({ label: m[1], selector: m[2] });
    else opts.selectors.push({ label: v, selector: v });
  };
  const addIgnore = v => { const c = compileIgnore(v); if (c) opts.ignore.push(c); };
  const addInclude = v => { const c = compileIgnore(v); if (c) opts.include.push(c); };
  const addIgnoreFile = v => {
    let content;
    try { content = fs.readFileSync(v, 'utf8'); }
    catch (e) { fail(`cannot read ignore file: ${v}`); }
    for (const line of content.split('\n')) { const c = compileIgnore(line); if (c) opts.ignore.push(c); }
  };
  // Short flags that take a value (rest of the cluster, or the next argument).
  const shortValueFlags = {
    w: setMaxWidth, m: setMaxCount, M: setMaxTotal, A: setAfter, B: setBefore, C: setContext,
    i: addIgnore, e: addSelector,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // Long options: --name or --name=value. A missing inline value is taken
    // from the next argument (except --color, where a bare flag means "auto",
    // as in GNU grep).
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      const value = () => {
        if (inline != null) return inline;
        if (i + 1 >= argv.length) fail(`option ${name} requires a value`);
        return argv[++i];
      };
      switch (name) {
        case '--help': process.stdout.write(USAGE + '\n'); process.exit(0); break;
        case '--version': process.stdout.write(`cssgrep ${VERSION}\n`); process.exit(0); break;
        case '--recursive': opts.recursive = true; break;
        case '--follow': opts.follow = true; break;
        case '--line-number': opts.lineNumber = true; break;
        case '--print': opts.print = true; break;
        case '--count': opts.count = true; break;
        case '--files-with-matches': opts.filesWithMatches = true; break;
        case '--files-without-match': opts.filesWithoutMatch = true; break;
        case '--quiet': case '--silent': opts.quiet = true; break;
        case '--null': opts.nul = true; break;
        case '--with-filename': opts.withFilename = true; break;
        case '--no-filename': opts.noFilename = true; break;
        case '--no-messages': opts.noMessages = true; break;
        case '--ext': setExts(value()); break;
        case '--ignore': case '--exclude': addIgnore(value()); break;
        case '--ignore-file': addIgnoreFile(value()); break;
        case '--include': addInclude(value()); break;
        case '--max-width': setMaxWidth(value()); break;
        case '--max-count': setMaxCount(value()); break;
        case '--max-total': setMaxTotal(value()); break;
        case '--max-depth': setMaxDepth(value()); break;
        // htmlparser2 lowercases HTML attribute names, so match case-insensitively.
        case '--attr': opts.attr = value().toLowerCase(); break;
        case '--text': opts.text = true; break;
        case '--json': opts.json = true; break;
        case '--parent': setParent(value()); break;
        case '--after-context': setAfter(value()); break;
        case '--before-context': setBefore(value()); break;
        case '--context': setContext(value()); break;
        case '--color': case '--colour': opts.color = inline != null ? inline : 'auto'; break;
        case '--selector': addSelector(value()); break;
        case '--add-class': opts.rewrite.addClass.push(value()); break;
        case '--remove-class': opts.rewrite.removeClass.push(value()); break;
        case '--remove-attr': opts.rewrite.removeAttr.push(value()); break;
        case '--set-attr': {
          const v = value();
          const eq = v.indexOf('=');
          const k = eq === -1 ? v : v.slice(0, eq);
          if (!k) fail('--set-attr requires a name (name=value)');
          opts.rewrite.setAttr[k] = eq === -1 ? '' : v.slice(eq + 1);
          break;
        }
        case '--rename-tag': opts.rewrite.renameTag = value(); break;
        case '--diff': opts.diff = true; break;
        case '--watch': opts.watch = true; break;
        case '--no-clear': opts.noClear = true; break;
        case '--invert-match': failInvert(name); break;
        default: fail(`unknown option: ${name}`);
      }
      continue;
    }

    // Short options, getopt-style: flags cluster (`-rn`) and a value-taking
    // option consumes the rest of the cluster (`-w100`) or the next argument
    // (`-w 100`), which means it must come last in a cluster (`-rnw100`).
    if (a.startsWith('-') && a !== '-') {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (shortValueFlags[ch]) {
          const rest = a.slice(j + 1);          // attached value, if any
          if (rest === '' && i + 1 >= argv.length) fail(`option -${ch} requires a value`);
          shortValueFlags[ch](rest !== '' ? rest : argv[++i]);
          break;                                // value swallowed the cluster tail
        }
        switch (ch) {
          case 'h': process.stdout.write(USAGE + '\n'); process.exit(0); break;
          case 'V': process.stdout.write(`cssgrep ${VERSION}\n`); process.exit(0); break;
          case 'r': opts.recursive = true; break;
          case 'S': opts.follow = true; break;
          case 'n': opts.lineNumber = true; break;
          case 'p': opts.print = true; break;
          case 'c': opts.count = true; break;
          case 'l': opts.filesWithMatches = true; break;
          case 'L': opts.filesWithoutMatch = true; break;
          case 'q': opts.quiet = true; break;
          case '0': case 'Z': opts.nul = true; break;
          case 'H': opts.withFilename = true; break;
          case 's': opts.noMessages = true; break;
          case 'v': failInvert('-v'); break;
          default: fail(`unknown option: -${ch}`);
        }
      }
      continue;
    }

    opts.positionals.push(a);
  }
  if (opts.positionals.length === 0 && !opts.selectors.length) {
    fail('no selector given (try --help)');
  }
  // Aggregate modes each suppress per-match output, so at most one may apply.
  const aggregates = [opts.count, opts.filesWithMatches, opts.filesWithoutMatch, opts.quiet]
    .filter(Boolean).length;
  if (aggregates > 1) fail('only one of -c, -l, -L, -q may be given');
  // Filename prefix can be forced on or off, but not both (grep -H / -h).
  if (opts.withFilename && opts.noFilename) fail('-H cannot be combined with --no-filename');
  // --include fully replaces the extension filter, so the two can't coexist.
  if (opts.extGiven && opts.include.length) fail('--ext and --include cannot be combined');
  // Per-match print modes choose what is printed for each match; only one.
  const printModes = [opts.print, opts.attr != null, opts.text, opts.json].filter(Boolean).length;
  if (printModes > 1) fail('only one of -p, --attr, --text, --json may be given');
  // Context surrounds source lines, so it only makes sense for the default line
  // output — not the print modes or the content-suppressing aggregate modes.
  if (opts.before > 0 || opts.after > 0) {
    if (printModes > 0) fail('context (-A/-B/-C) cannot be combined with -p/--attr/--text/--json');
    if (aggregates > 0) fail('context (-A/-B/-C) cannot be combined with -c/-l/-L/-q');
  }
  if (opts.lineNumber && opts.count) fail('-n cannot be combined with -c');
  if (opts.lineNumber && opts.print) fail('-n cannot be combined with -p');
  // Rewrite is its own program mode, not a fourth output axis: it emits a
  // document (or a diff), so everything that shapes per-match output is
  // meaningless with it.
  const r = opts.rewrite;
  opts.rewriteActive = Boolean(r.renameTag) || r.removeAttr.length > 0
    || r.removeClass.length > 0 || r.addClass.length > 0
    || Object.keys(r.setAttr).length > 0;
  if (opts.diff && !opts.rewriteActive) fail('--diff requires a rewrite operation');
  if (opts.rewriteActive) {
    if (printModes > 0) fail('rewrite operations cannot be combined with -p/--attr/--text/--json');
    if (aggregates > 0) fail('rewrite operations cannot be combined with -c/-l/-L/-q');
    if (opts.before > 0 || opts.after > 0) fail('rewrite operations cannot be combined with -A/-B/-C');
    if (opts.lineNumber) fail('rewrite operations cannot be combined with -n');
    if (opts.maxWidth) fail('rewrite operations cannot be combined with -w');
    if (opts.nul) fail('rewrite operations cannot be combined with -0');
    if (opts.maxCount || opts.maxTotal) fail('rewrite operations cannot be combined with -m/-M');
    if (opts.selectors.length) {
      fail('rewrite takes a single positional selector (use a selector list like "a, b" instead of -e)');
    }
  }
  // Watch re-runs the search on change; modes that end the run early or edit
  // files make no sense against it.
  if (opts.noClear && !opts.watch) fail('--no-clear requires --watch');
  if (opts.watch) {
    if (opts.quiet) fail('--watch cannot be combined with -q');
    if (opts.rewriteActive) fail('--watch cannot be combined with rewrite operations');
    if (opts.noClear && opts.json) fail('--no-clear is meaningless with --json (it never clears)');
  }
  if (!['auto', 'always', 'never'].includes(opts.color)) {
    fail(`invalid --color value: ${opts.color} (expected auto, always or never)`);
  }
  // Resolve the tri-state into a single boolean: color only when forced on, or
  // 'auto' and stdout is an interactive terminal. -p uses it for syntax
  // highlighting (and --parent -p for the match region on top of it).
  opts.colorOn = opts.color === 'always' || (opts.color === 'auto' && Boolean(process.stdout.isTTY));
  return opts;
}

// The selector and the path list share the same positional slots, so their
// order on the command line is ambiguous (`<selector> <dir>` vs `<dir>
// <selector>`). Resolve it by what actually exists on disk: paths are the
// positionals that name a real file/dir, and the selector is the one that
// doesn't. This makes argument order not matter (important for vim's
// `grepprg`, which appends args in its own order). Fall back to
// "selector is the first positional" when the split is unclear.
function resolveSelectorAndPaths(opts) {
  // With -e the selectors are explicit, so — like grep -e — every positional
  // is a file path; a mistyped one is reported as unreadable, not re-guessed
  // as a selector.
  if (opts.selectors.length) {
    opts.paths = opts.positionals;
    return;
  }
  const pos = opts.positionals;
  const onDisk = [];
  const notOnDisk = [];
  for (const p of pos) {
    if (fs.statSync(p, { throwIfNoEntry: false })) onDisk.push(p);
    else notOnDisk.push(p);
  }
  if (notOnDisk.length === 1) {
    opts.selector = notOnDisk[0];
    opts.paths = onDisk;
  } else {
    // 0 non-existent (selector also happens to name a file) or several
    // (a mistyped path, reported later): keep positional order.
    opts.selector = pos[0];
    opts.paths = pos.slice(1);
  }
}

// Never cut between the halves of a surrogate pair: a lone half is invalid
// Unicode and serializes as U+FFFD garbage. Backing off one unit loses at most
// one display column.
function safeCut(text, at) {
  const c = text.charCodeAt(at - 1);
  return c >= 0xd800 && c <= 0xdbff ? at - 1 : at;
}

function truncate(text, maxWidth) {
  if (!maxWidth || text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, safeCut(text, maxWidth));
  return text.slice(0, safeCut(text, maxWidth - 1)) + '…'; // …
}

// Produce the visible match text: truncate first (so --max-width still measures
// real columns, never escape sequences), then — when coloring — wrap the part
// of the matched node that falls on this line in the match color. A node can
// span multiple lines while we only print its opening line, so the highlight is
// clamped to what's visible; a match scrolled past the truncation point isn't
// highlighted at all (and the trailing ellipsis is never colored).
function renderText(pos, off, nodeEnd, opts) {
  const vis = truncate(pos.text, opts.maxWidth);
  if (!opts.colorOn) return vis;
  const truncated = opts.maxWidth && pos.text.length > opts.maxWidth;
  const effLen = truncated ? Math.max(0, opts.maxWidth - 1) : vis.length;
  let s = pos.col - 1;             // match start within the line (0-based)
  let e = s + (nodeEnd - off);     // match end within the line
  s = Math.max(0, Math.min(s, effLen));
  e = Math.max(s, Math.min(e, effLen));
  if (e <= s) return vis;          // nothing of the match is visible
  return vis.slice(0, s) + paint(COLORS.match, vis.slice(s, e)) + vis.slice(e);
}

// Sentinels marking where a highlighted node begins/ends. They are injected as
// HTML *comment* nodes (not text) so js-beautify keeps the surrounding block
// layout — text markers would make adjacent block elements collapse inline.
// The private-use payload can't occur in real content, so it never collides.
// After beautifying, each `<!--…-->` marker is swapped for an ANSI code.
const HL_START = '';
const HL_END = '';

// Syntax-highlight a pretty-printed HTML block: tag names, attribute names,
// attribute values (quotes included) and comments/doctypes get their own
// colors; text content and punctuation stay unpainted. Spans come from the
// same opening-tag lexer the rewrite mode uses, so a quoted '>' never
// confuses the scan.
function highlightHtml(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '<' && (s.startsWith('<!--', i) || s[i + 1] === '!')) {
      const close = s.startsWith('<!--', i) ? '-->' : '>';
      let end = s.indexOf(close, i + 2);
      end = end === -1 ? s.length : end + close.length;
      out += paint(COLORS.comment, s.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '<' && s[i + 1] === '/') {
      const m = /^<\/([^\s>]*)([^>]*>?)/.exec(s.slice(i));
      out += '</' + paint(COLORS.tag, m[1]) + m[2];
      i += m[0].length;
      continue;
    }
    if (ch === '<' && /[a-zA-Z]/.test(s[i + 1] || '')) {
      const lx = lexOpenTag(s, i);
      out += '<' + paint(COLORS.tag, s.slice(lx.nameStart, lx.nameEnd));
      let j = lx.nameEnd;
      for (const a of lx.attrs) {
        out += s.slice(j, a.start) + paint(COLORS.attr, s.slice(a.start, a.nameEnd));
        if (a.vStart >= 0) {
          const quote = s[a.vStart - 1];
          const valFrom = quote === '"' || quote === "'" ? a.vStart - 1 : a.vStart;
          out += s.slice(a.nameEnd, valFrom) + paint(COLORS.value, s.slice(valFrom, a.end));
        }
        j = a.end;
      }
      out += s.slice(j, lx.end);
      i = lx.end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Re-indent a matched node's HTML from scratch (so minified input still comes
// out readable). dom-serializer turns the parsed node back into a string;
// js-beautify does the formatting. With color on the block is syntax-
// highlighted; when `origins` (descendant nodes to highlight) is also given,
// those nodes are wrapped in the match color instead — match red wins over
// syntax inside its region.
function prettyPrint(el, origins, opts) {
  loadPrettyPrinter();
  const colorOn = Boolean(opts && opts.colorOn);
  const highlight = origins && origins.length && colorOn;
  const inserted = [];
  if (highlight) {
    // Bracket each origin with sentinel comment nodes among its siblings.
    for (const m of origins) {
      if (!m.parent) continue;
      const kids = m.parent.children;
      const i = kids.indexOf(m);
      if (i < 0) continue;
      const start = { type: 'comment', data: HL_START };
      const end = { type: 'comment', data: HL_END };
      kids.splice(i, 0, start);
      kids.splice(i + 2, 0, end);
      inserted.push({ kids, start, end });
    }
  }
  let html;
  try {
    html = beautify(render(el, { encodeEntities: false }), {
      indent_size: 2,
      wrap_line_length: 0, // never wrap long lines (e.g. long text/attributes)
      preserve_newlines: false,
    });
  } finally {
    // Always restore the DOM so the markers don't leak into later matches.
    for (const { kids, start, end } of inserted) {
      let k = kids.indexOf(start); if (k >= 0) kids.splice(k, 1);
      k = kids.indexOf(end); if (k >= 0) kids.splice(k, 1);
    }
  }
  if (!colorOn) return html;
  if (!highlight) return highlightHtml(html);
  // Split on the sentinel comments: regions outside the match get syntax
  // highlighting, the match region itself gets the match color, unbroken —
  // syntax codes inside would end the red at every token.
  const startCode = `\x1b[${COLORS.match}m`;
  const resetCode = '\x1b[0m';
  const isStart = new RegExp(`^<!--\\s*${HL_START}\\s*-->$`);
  const isEnd = new RegExp(`^<!--\\s*${HL_END}\\s*-->$`);
  let out = '';
  let inside = false;
  for (const part of html.split(new RegExp(`(<!--\\s*[${HL_START}${HL_END}]\\s*-->)`, 'g'))) {
    if (isStart.test(part)) { out += startCode; inside = true; continue; }
    if (isEnd.test(part)) { out += resetCode; inside = false; continue; }
    out += inside ? part : highlightHtml(part);
  }
  return foldStandaloneCodes(out, startCode, resetCode);
}

// beautify sometimes parks a marker comment on its own line (e.g. when the
// matched node followed source whitespace), leaving a line of just indent + a
// zero-width ANSI code — a spurious blank line. Fold such a code onto the
// adjacent content line: a start code onto the next line, a reset onto the
// previous one.
function foldStandaloneCodes(html, startCode, resetCode) {
  const lines = html.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)(\x1b\[[0-9;]*m)[ \t]*$/);
    if (m) {
      const code = m[2];
      if (code === startCode && i + 1 < lines.length) {
        lines[i + 1] = lines[i + 1].replace(/^[ \t]*/, ws => ws + startCode);
        continue; // drop the standalone line
      }
      if (code === resetCode && out.length) {
        out[out.length - 1] += resetCode;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

// -A/-B/-C: emit each match line plus its surrounding context lines, grep-style.
// Match lines use `:` field separators and keep the match-node highlight;
// context lines use `-` and no highlight. Overlapping context windows merge,
// and `--` separates non-contiguous groups.
function emitContext(src, starts, name, showLabel, targets, opts, out) {
  const label = showLabel ? name : null;
  const c = opts.colorOn ? paint : (_, s) => s;
  const lineCount = src.length === 0 ? 0 : (src.endsWith('\n') ? starts.length - 1 : starts.length);

  // Map each match line to a representative node span (the first match on it),
  // which drives the in-line highlight — and the [label] tag — when emitting.
  const info = new Map();
  const posState = {};
  for (const { el, base, label: selLabel } of targets) {
    const off = base + (el.startIndex == null ? 0 : el.startIndex);
    const pos = offsetToPosition(starts, src, off, posState);
    if (info.has(pos.line)) continue;
    const nodeEnd = base + (el.endIndex == null ? off - base : el.endIndex) + 1;
    info.set(pos.line, { off, nodeEnd, pos, selLabel });
  }

  // Expand match lines to [L-before, L+after] windows and merge adjacent ones.
  const ranges = [];
  for (const L of [...info.keys()].sort((a, b) => a - b)) {
    const lo = Math.max(1, L - opts.before);
    const hi = Math.min(lineCount, L + opts.after);
    const last = ranges[ranges.length - 1];
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi);
    else ranges.push({ lo, hi });
  }

  let firstGroup = true;
  for (const { lo, hi } of ranges) {
    if (!firstGroup) out.push('--');
    firstGroup = false;
    for (let L = lo; L <= hi; L++) {
      const m = info.get(L);
      const sepColored = c(COLORS.sep, m ? ':' : '-');
      let prefix = '';
      if (label) prefix += c(COLORS.file, label) + (opts.nul ? '\0' : sepColored);
      if (opts.lineNumber) {
        prefix += c(COLORS.line, String(L));
        prefix += m ? c(COLORS.sep, ':') + c(COLORS.line, String(m.pos.bcol)) + ' '
                    : c(COLORS.sep, '-');
      }
      const tag = m && m.selLabel != null ? c(COLORS.label, `[${m.selLabel}]`) + ' ' : '';
      const body = m
        ? tag + renderText(m.pos, m.off, m.nodeEnd, opts)  // highlight + truncate
        : truncate(lineTextAt(starts, src, L).text, opts.maxWidth);
      out.push(prefix + body);
    }
  }
}

// `name` is the source's display name (file path, or "(standard input)"); it is
// used by the aggregate modes (-l/-L/-c). `showLabel` decides whether per-match
// lines carry a `file:` prefix (only when more than one file is searched).
function searchSource(src, name, showLabel, opts, out, limit = Infinity, embedded = false) {
  // The lib owns parsing and selection: one parse per source, then one
  // doc.search() per selector against the same tree. The CLI works on the
  // raw nodes (the match objects' documented escape hatch) because its
  // output modes need node-level access the match shape doesn't model
  // (pretty-printing, ancestor re-targeting, in-line highlight spans).
  //
  // A plain HTML file is one fragment covering the whole source (base 0).
  // An embedded (JS/TS) file contributes one fragment per markup-sniffing
  // template literal — holes masked to same-length whitespace, so fragment
  // offsets + base ARE host-file offsets — each parsed as its own document,
  // so an unclosed tag in one literal can never swallow the next.
  const docs = (embedded ? extractHtmlFragments(src) : [{ start: 0, masked: src }])
    .map(f => ({ doc: parse(f.masked), base: f.start }));
  // One record per (selector, matched node): with -e a node matched by two
  // selectors is reported once per selector, tagged with each label, and the
  // merged stream is in document order (same node = same offset, so the
  // stable sort keeps command-line selector order for ties). A positional
  // selector is the degenerate case with a null label, which suppresses the
  // [label] tag and the --json `label` field everywhere.
  const selList = opts.selectors.length
    ? opts.selectors
    : [{ label: null, selector: opts.selector }];
  const records = [];
  for (const s of selList) {
    for (const { doc, base } of docs) {
      for (const m of doc.search(s.selector)) records.push({ el: m.node, base, label: s.label });
    }
  }
  if (selList.length > 1 || docs.length > 1) {
    records.sort((a, b) => (a.base + (a.el.startIndex || 0)) - (b.base + (b.el.startIndex || 0)));
  }
  const found = records.length;
  // Aggregate modes suppress per-match output entirely.
  if (opts.quiet) return found;                                  // status only
  if (opts.filesWithMatches) { if (found) out.push(name); return found; }
  if (opts.filesWithoutMatch) { if (!found) out.push(name); return found; }

  const label = showLabel ? name : null;
  // -m/--max-count caps matches per source; `limit` is the remaining global
  // budget from -M/--max-total (Infinity when neither applies).
  const cap = Math.min(opts.maxCount || Infinity, limit);
  const limited = Number.isFinite(cap) ? records.slice(0, cap) : records;
  if (opts.count) {
    // grep parity: every searched file reports a count, zeros included, so
    // scripts get one row per file (exit status still says whether anything
    // matched at all).
    const fileSep = opts.nul ? '\0' : ':';
    out.push(label ? `${label}${fileSep}${limited.length}` : String(limited.length));
    return limited.length;
  }
  // Nothing to emit: return before building the line index — a zero-match
  // pass over a large file shouldn't pay a full line scan for nothing.
  if (limited.length === 0) return 0;
  // Positions are host-file positions: fragments preserve line structure, so
  // the host source's own line index serves embedded matches directly.
  const starts = opts.print ? null
    : embedded ? lineIndex(src)
    : docs[0].doc.lineStarts();
  // --parent re-targets matches to ancestors (no-op without it; never leaves
  // the match's own fragment). Dedup is per (ancestor, label), so two -e
  // selectors sharing a container still report it once each. Aggregate modes
  // above operate on the raw matches; targeting only affects what prints.
  let targets = limited;
  if (opts.parent) {
    targets = [];
    const seen = new Map();                       // ancestor -> Set of labels
    for (const r of limited) {
      const a = ancestor(r.el, opts.parent);
      let labels = seen.get(a);
      if (!labels) { labels = new Set(); seen.set(a, labels); }
      if (!labels.has(r.label)) {
        labels.add(r.label);
        targets.push({ el: a, base: r.base, label: r.label });
      }
    }
  }
  // For --parent + -p, remember which original matches sit under each ancestor
  // so they can be highlighted inside the printed container.
  const originsByTarget = new Map();
  if (opts.parent && opts.print) {
    for (const r of limited) {
      const a = ancestor(r.el, opts.parent);
      if (!originsByTarget.has(a)) originsByTarget.set(a, []);
      originsByTarget.get(a).push(r.el);
    }
  }
  if (opts.before > 0 || opts.after > 0) {
    emitContext(src, starts, name, showLabel, targets, opts, out);
    return limited.length;
  }
  // From here on the return value is the number of *emitted* records (which is
  // what the -M budget and the exit status should count): --attr can skip
  // matches lacking the attribute, and --parent dedup can merge several
  // matches into one printed ancestor.
  if (opts.json) {
    // NDJSON: one self-contained record per match. `attribs` mirrors the lib
    // Match's field (names lowercased by the parser) so scraping never needs
    // a second pass; `html` is the exact source slice; newlines are escaped
    // by JSON.stringify, so each record stays on one line. Ignores --color
    // and -n (line/col are always present). `label` appears only with -e.
    const posState = {};
    for (const { el, base, label: selLabel } of targets) {
      const off = base + (el.startIndex == null ? 0 : el.startIndex);
      const pos = offsetToPosition(starts, src, off, posState);
      const nodeEnd = base + (el.endIndex == null ? off - base : el.endIndex) + 1;
      out.push(JSON.stringify({
        file: name,
        line: pos.line,
        col: pos.bcol,
        ...(selLabel !== null && { label: selLabel }),
        attribs: el.attribs || {},
        html: src.slice(off, nodeEnd),
        text: collapseWs(textOf(el)),
      }));
    }
    return targets.length;
  }
  let emitted = 0;
  // grep parity: without -n, a physical line prints once no matter how many
  // matches sit on it (grep never repeats a line). With -n each match keeps
  // its own line:col record — that per-match locator is the tool's point.
  // Extraction modes print per-match values, so they never dedup.
  const seenLines = (opts.lineNumber || opts.attr != null || opts.text) ? null : new Set();
  const posState = {};
  for (const { el, base, label: selLabel } of targets) {
    const c = opts.colorOn ? paint : (_, s) => s;
    // The [label] tag from -e; a null label (positional selector) prints none.
    const tag = selLabel === null ? '' : c(COLORS.label, `[${selLabel}]`) + ' ';
    if (opts.print) {
      // -p shows the re-indented node only; no line:col locator (the [label]
      // tag gets its own line above the block). With --parent, the original
      // matched descendants are highlighted inside the container.
      if (tag) out.push(tag.trimEnd());
      out.push(prettyPrint(el, originsByTarget.get(el), opts), ''); // blank separator
      emitted++;
      continue;
    }
    const off = base + (el.startIndex == null ? 0 : el.startIndex);
    const pos = offsetToPosition(starts, src, off, posState);

    // Choose the content printed for this match. --attr/--text replace the
    // source line with the extracted value (whole value highlighted as the
    // match); both honor -w truncation. Nodes lacking the attribute are skipped.
    let text;
    if (opts.attr != null) {
      if (!el.attribs || !(opts.attr in el.attribs)) continue;
      text = c(COLORS.match, truncate(el.attribs[opts.attr], opts.maxWidth));
    } else if (opts.text) {
      text = c(COLORS.match, truncate(collapseWs(textOf(el)), opts.maxWidth));
    } else {
      if (seenLines) {
        if (seenLines.has(pos.line)) continue;    // this line already printed
        seenLines.add(pos.line);
      }
      const nodeEnd = base + (el.endIndex == null ? off - base : el.endIndex) + 1; // exclusive
      text = renderText(pos, off, nodeEnd, opts);
    }
    // grep-style: a `file:` prefix appears with multiple files; the line:col
    // locator only with -n. The locator is separated from the text by a space
    // so the output stays :grep-compatible (grepformat %f:%l:%c %m).
    const sep = c(COLORS.sep, ':');
    // -0/--null: the char after the file name becomes NUL (grep -Z), for
    // unambiguous machine parsing (e.g. xargs -0).
    const fileSep = opts.nul ? '\0' : sep;
    let prefix = '';
    if (label) prefix += c(COLORS.file, label) + fileSep;
    if (opts.lineNumber) {
      prefix += c(COLORS.line, String(pos.line)) + sep + c(COLORS.line, String(pos.bcol)) + ' ';
    }
    out.push(prefix + tag + text);
    emitted++;
  }
  return emitted;
}

// Translate a glob to a regex body. `*` matches within a path segment, `**`
// across segments, `?` a single non-slash char, `{a,b,c}` alternation; every
// other char is literal.
function globToRegex(glob) {
  let re = '';
  let depth = 0;                            // open `{` alternation groups
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {            // **  (crosses /)
        i++;
        if (glob[i + 1] === '/') {
          // `**/` spans whole segments (or none): `**/foo` matches `foo` and
          // `a/b/foo`, but not `barfoo` — the `.*` must end at a `/`.
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(';
      depth++;
    } else if (c === '}' && depth > 0) {
      re += ')';
      depth--;
    } else if (c === ',' && depth > 0) {
      re += '|';
    } else if (/[.+^$()|[\]\\]/.test(c)) {  // note: { } handled above
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  while (depth-- > 0) re += ')';            // close any unbalanced `{`
  return re;
}

// Compile one ignore pattern (gitignore-flavored). A trailing `/` makes it
// match directories only; a pattern containing `/` matches against the path
// (anchored at a segment boundary), otherwise against the basename.
function compileIgnore(pattern) {
  const p = pattern.trim().replace(/\/$/, '');
  if (!p || pattern.trim().startsWith('#')) return null;  // blank / comment line
  const dirOnly = /\/$/.test(pattern.trim());
  const hasSlash = p.includes('/');
  const body = globToRegex(p);
  const re = hasSlash ? new RegExp('(^|/)' + body + '$') : new RegExp('^' + body + '$');
  return { re, dirOnly, hasSlash };
}

// True if name/path matches any compiled glob matcher (shared by --ignore/
// --exclude and --include). Globs always use `/` as the separator (gitignore
// semantics), so normalize Windows backslash paths before matching.
function matchesAny(name, full, isDir, matchers) {
  const fullPosix = path.sep === '/' ? full : full.split(path.sep).join('/');
  for (const m of matchers) {
    if (m.dirOnly && !isDir) continue;
    if (m.re.test(m.hasSlash ? fullPosix : name)) return true;
  }
  return false;
}

// `visited` (only with -S/--follow) holds the realpath of every directory
// already entered, so symlink cycles — and two links to the same physical
// directory — are traversed once. Without --follow, symlinks are skipped.
function* walk(dir, opts, depth = 1, visited = null) {
  if (opts.follow && visited === null) {
    visited = new Set();
    try { visited.add(fs.realpathSync(dir)); } catch (e) { /* walked anyway */ }
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (!opts.noMessages) process.stderr.write(`cssgrep: ${dir}: ${e.code || e.message}\n`);
    return;
  }
  // readdir order is filesystem-dependent; sort so output order (and therefore
  // -M/-m truncation points) is stable across platforms.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (opts.follow && e.isSymbolicLink()) {
      const st = fs.statSync(full, { throwIfNoEntry: false }); // resolves the link
      if (!st) continue;                                       // broken link
      isDir = st.isDirectory();
      isFile = st.isFile();
    }
    if (opts.ignore.length && matchesAny(e.name, full, isDir, opts.ignore)) continue;
    if (isDir) {
      if (opts.follow) {
        let real;
        try { real = fs.realpathSync(full); } catch (err) { continue; }
        if (visited.has(real)) continue;    // cycle or already-walked dir
        visited.add(real);
      }
      // --max-depth caps how far we descend; depth 1 = the target's children.
      if (!opts.maxDepth || depth < opts.maxDepth) yield* walk(full, opts, depth + 1, visited);
    } else if (isFile) {
      // --include replaces the extension filter; otherwise filter by --ext.
      if (opts.include.length) {
        if (matchesAny(e.name, full, false, opts.include)) yield full;
      } else {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (opts.exts.includes(ext)) yield full;
      }
    }
  }
}

function readStdin() {
  return fs.readFileSync(0); // Buffer: sniffed for binary before decoding
}

// Heuristic binary-file detector (grep/git style). A NUL byte in the first 8 KB
// is a decisive binary signal; failing that, a high ratio of non-text control
// bytes flags binary content that happens to lack NULs. HTML is text, so binary
// files are never worth parsing and are skipped. (stat() can't tell us this —
// only the bytes can.)
const BINARY_SNIFF_BYTES = 8192;
function looksBinary(buf) {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;                       // NUL: definitely binary
    if (b < 9 || (b > 13 && b < 32)) suspicious++;  // control char (not \t\n\v\f\r)
  }
  return n > 0 && suspicious / n > 0.3;
}

// --- rewrite output -----------------------------------------------------------

// Myers O(ND) shortest edit script over lines. Only ever runs on the middle
// slice left after common prefix/suffix trimming, which transform()'s local
// splices keep small.
function myersDiff(a, b) {
  const N = a.length, M = b.length, max = N + M, off = max;
  if (max === 0) return [];
  const trace = [];
  const v = new Array(2 * max + 2).fill(0);
  let D = -1;
  for (let d = 0; d <= max && D < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]))
        ? v[off + k + 1]
        : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { D = d; break; }
    }
  }
  const script = [];
  let x = N, y = M;
  for (let d = D; d > 0; d--) {
    const vp = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vp[off + k - 1] < vp[off + k + 1])) ? k + 1 : k - 1;
    const prevX = vp[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) { script.push({ t: ' ', l: a[--x] }); y--; }
    if (x === prevX) script.push({ t: '+', l: b[--y] });
    else script.push({ t: '-', l: a[--x] });
  }
  while (x > 0 && y > 0) { script.push({ t: ' ', l: a[--x] }); y--; }
  while (x > 0) script.push({ t: '-', l: a[--x] });
  while (y > 0) script.push({ t: '+', l: b[--y] });
  return script.reverse();
}

// Unified diff of two documents, git-apply compatible: ---/+++ headers with
// a/ b/ prefixes, 3 context lines, merged hunks, and "\ No newline at end of
// file" markers when a side's last line is unterminated.
function unifiedDiff(name, oldStr, newStr) {
  const split = s => {
    const lines = s.split('\n');
    const noEol = lines[lines.length - 1] !== '';
    if (!noEol) lines.pop();
    return { lines, noEol };
  };
  const A = split(oldStr), B = split(newStr);
  const a = A.lines, b = B.lines;
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre
    && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const script = [
    ...a.slice(0, pre).map(l => ({ t: ' ', l })),
    ...myersDiff(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)),
    ...a.slice(a.length - suf).map(l => ({ t: ' ', l })),
  ];

  // Old/new line number sitting *before* each script entry (1-based).
  const oldPos = [], newPos = [];
  let ol = 1, nl = 1;
  for (const s of script) {
    oldPos.push(ol);
    newPos.push(nl);
    if (s.t !== '+') ol++;
    if (s.t !== '-') nl++;
  }

  // Group changes into hunks: 3 context lines, merge when gaps are ≤ 6.
  const C = 3;
  const hunks = [];
  let i = 0;
  while (i < script.length) {
    if (script[i].t === ' ') { i++; continue; }
    const hStart = Math.max(0, i - C);
    let lastChange = i;
    let j = i + 1;
    while (j < script.length) {
      if (script[j].t !== ' ') { lastChange = j; j++; continue; }
      let k = j;
      while (k < script.length && script[k].t === ' ') k++;
      if (k === script.length || k - j > 2 * C) break;
      j = k;
    }
    const hEnd = Math.min(script.length, lastChange + C + 1);
    hunks.push([hStart, hEnd]);
    i = hEnd;
  }

  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (const [s, e] of hunks) {
    let oc = 0, nc = 0;
    for (let k = s; k < e; k++) {
      if (script[k].t !== '+') oc++;
      if (script[k].t !== '-') nc++;
    }
    const os = oc ? oldPos[s] : oldPos[s] - 1;
    const ns = nc ? newPos[s] : newPos[s] - 1;
    out.push(`@@ -${os},${oc} +${ns},${nc} @@`);
    for (let k = s; k < e; k++) {
      const { t, l } = script[k];
      out.push(t + l);
      const atOldEnd = t !== '+' && oldPos[k] === a.length && A.noEol;
      const atNewEnd = t !== '-' && newPos[k] === b.length && B.noEol;
      if (atOldEnd || atNewEnd) out.push('\\ No newline at end of file');
    }
  }
  return out.join('\n') + '\n';
}

// The rewrite program mode: transform each source and emit the document
// (single input) or a unified diff (any number of files). Never writes a
// file — apply diffs with git apply / patch (see ROADMAP Phase 9).
function rewriteMain(opts, files, useStdin) {
  if (!useStdin && files.length > 1 && !opts.diff) {
    fail('rewriting multiple files requires --diff');
  }
  const sources = [];
  if (useStdin) {
    sources.push({ name: '(standard input)', buf: readStdin() });
  } else {
    for (const f of files) {
      try {
        sources.push({ name: f, buf: fs.readFileSync(f) });
      } catch (e) {
        if (!opts.noMessages) process.stderr.write(`cssgrep: ${f}: ${e.code || e.message}\n`);
      }
    }
  }
  let totalEdits = 0;
  const diffs = [];
  for (const { name, buf } of sources) {
    // A rewriter must never corrupt bytes it didn't edit: binary input is
    // never HTML, and a lossy UTF-8 decode written back would mangle every
    // non-UTF-8 byte in the file — refuse both outright (exit 2).
    if (looksBinary(buf)) fail(`${name}: binary input; refusing to rewrite`);
    const src = buf.toString('utf8');
    if (!Buffer.from(src, 'utf8').equals(buf)) {
      fail(`${name}: not valid UTF-8; refusing to rewrite`);
    }
    let result;
    try {
      result = parse(src).transform(opts.selector, { ...opts.rewrite, parent: opts.parent });
    } catch (e) {
      if (e && e.message && /selector|tokeniz|parse/i.test(e.message)) {
        fail(`invalid selector: ${opts.selector}`);
      }
      fail(e.message);
    }
    totalEdits += result.edits.length;
    if (opts.diff) {
      if (result.edits.length) diffs.push(unifiedDiff(name, src, result.html));
    } else {
      // Filter-friendly: the document is always emitted, changed or not
      // (like sed); the exit status says whether anything was edited.
      process.stdout.write(result.html);
    }
  }
  if (diffs.length) process.stdout.write(diffs.join(''));
  process.exitCode = totalEdits > 0 ? 0 : 1;
}

// The watch program mode: rerun the search whenever a watched path changes.
// Native recursive fs.watch, no polling (see ROADMAP Phase 10; caveat:
// network/virtual filesystems may not deliver events). Output adapts like
// --color=auto does: a TTY gets clear+reprint, a pipe gets append mode with
// `== HH:MM:SS … ==` separators (--no-clear forces append on a TTY), and
// --json gets an NDJSON stream — {"event":"run",...} then the match records.
// Runs until SIGINT (exit 0, like watch(1)).
function watchMain(opts) {
  const clearMode = !opts.json && !opts.noClear && Boolean(process.stdout.isTTY);
  const renderOut = out => (!out.length ? ''
    : opts.nul && (opts.filesWithMatches || opts.filesWithoutMatch)
      ? out.map(s => s + '\0').join('')
      : out.join('\n') + '\n');

  const run = changed => {
    // Re-walk every run: a rerun sees exactly what a fresh invocation would.
    const { files } = resolveFiles(opts);
    const out = [];
    let total = 0;
    try {
      total = searchFiles(opts, files, out);
    } catch (e) {
      if (e && e.message && /selector|tokeniz|parse/i.test(e.message)) {
        fail(`invalid selector: ${opts.selector != null
          ? opts.selector
          : opts.selectors.map(s => s.selector).join(', ')}`);
      }
      fail(e.message);
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        event: 'run',
        changed: changed || null,
        matches: total,
      }) + '\n' + renderOut(out));
    } else if (clearMode) {
      process.stdout.write('\x1b[2J\x1b[H' + (out.length ? renderOut(out) : 'cssgrep: no matches\n'));
    } else {
      const ts = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`== ${ts} ${changed || 'watching'} ==\n` + renderOut(out));
    }
  };

  // Debounce change bursts (editors often fire several events per save).
  let timer = null;
  let pending = null;
  const schedule = changed => {
    pending = changed;
    clearTimeout(timer);
    timer = setTimeout(() => { const c = pending; pending = null; run(c); }, 80);
  };

  // Directory targets get one recursive watcher each. Explicit file targets
  // are watched via their parent directory, filtered by name — editors often
  // save by rename-replace, which would orphan a watcher on the file itself.
  const watchers = [];
  const fileTargets = new Map();              // parent dir -> Set of basenames
  const targets = opts.paths.length ? opts.paths : ['.'];
  for (const p of targets) {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) {
      if (!opts.noMessages) process.stderr.write(`cssgrep: ${p}: no such file or directory\n`);
      continue;
    }
    if (st.isDirectory()) {
      watchers.push(fs.watch(p, { recursive: true },
        (ev, f) => schedule(f ? path.join(p, f) : p)));
    } else {
      const dir = path.dirname(p);
      if (!fileTargets.has(dir)) fileTargets.set(dir, new Set());
      fileTargets.get(dir).add(path.basename(p));
    }
  }
  for (const [dir, bases] of fileTargets) {
    watchers.push(fs.watch(dir,
      (ev, f) => { if (!f || bases.has(f)) schedule(f ? path.join(dir, f) : dir); }));
  }
  if (!watchers.length) fail('--watch: nothing to watch');
  for (const w of watchers) {
    w.on('error', e => {
      if (!opts.noMessages) process.stderr.write(`cssgrep: watch: ${e.message}\n`);
    });
  }

  process.on('SIGINT', () => {
    for (const w of watchers) w.close();
    clearTimeout(timer);
    process.exitCode = 0;                     // watch(1) convention
  });

  run(null);                                  // initial pass, then wait
}

// Resolve the paths to search into a concrete file list (or stdin). Watch
// mode calls this again on every rerun, so a rerun sees exactly what a fresh
// invocation would: new files picked up per the include/ignore/--ext rules,
// deleted ones dropped.
function resolveFiles(opts) {
  let files = [];
  let useStdin = false;
  if (opts.recursive) {
    // No path given with -r means "search here", like ripgrep.
    const targets = opts.paths.length ? opts.paths : ['.'];
    for (const p of targets) {
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (!st) { if (!opts.noMessages) process.stderr.write(`cssgrep: ${p}: no such file or directory\n`); continue; }
      if (st.isDirectory()) files.push(...walk(p, opts));
      else files.push(p);
    }
  } else if (opts.paths.length > 0) {
    files = opts.paths;
  } else {
    useStdin = true;
  }
  return { files, useStdin };
}

// One search pass over a file list; appends output lines to `out` and returns
// the match total. Shared by the single-shot main path and each watch rerun.
function searchFiles(opts, files, out) {
  // A label (file prefix) is shown when searching more than one file; -H forces
  // it on (even for one file or stdin) and --no-filename forces it off.
  const showLabel = opts.withFilename ? true
    : opts.noFilename ? false
    : files.length > 1;
  let total = 0;
  // -M/--max-total: remaining matches allowed across all files (Infinity = off).
  const room = () => (opts.maxTotal ? Math.max(0, opts.maxTotal - total) : Infinity);
  for (const f of files) {
    if (room() <= 0) break;               // -M: global budget exhausted
    let buf;
    try {
      buf = fs.readFileSync(f);           // Buffer: sniff before decoding
    } catch (e) {
      if (!opts.noMessages) process.stderr.write(`cssgrep: ${f}: ${e.code || e.message}\n`);
      continue;
    }
    if (looksBinary(buf)) {
      if (!opts.noMessages && !opts.quiet) {
        process.stderr.write(`cssgrep: ${f}: binary file (skipped)\n`);
      }
      continue;
    }
    total += searchSource(buf.toString('utf8'), f, showLabel, opts, out, room(), isEmbeddedPath(f));
    if (opts.quiet && total > 0) break;   // -q: first match decides the status
  }
  return total;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  resolveSelectorAndPaths(opts);

  const { files, useStdin } = resolveFiles(opts);

  if (opts.rewriteActive) {
    rewriteMain(opts, files, useStdin);
    return;
  }
  if (opts.watch) {
    if (useStdin) fail('--watch requires file or directory paths');
    watchMain(opts);
    return;
  }

  const showLabel = opts.withFilename ? true
    : opts.noFilename ? false
    : (!useStdin && files.length > 1);

  const out = [];
  let total = 0;

  try {
    if (useStdin) {
      const buf = readStdin();
      if (looksBinary(buf)) {
        if (!opts.noMessages && !opts.quiet) {
          process.stderr.write('cssgrep: (standard input): binary input (skipped)\n');
        }
      } else {
        total += searchSource(buf.toString('utf8'), '(standard input)', showLabel, opts, out,
          opts.maxTotal || Infinity);
      }
    } else {
      total = searchFiles(opts, files, out);
    }
  } catch (e) {
    if (e && e.message && /selector|tokeniz|parse/i.test(e.message)) {
      const shown = opts.selector != null
        ? opts.selector
        : opts.selectors.map(s => s.selector).join(', ');
      fail(`invalid selector: ${shown}`);
    }
    fail(e.message);
  }

  if (out.length) {
    // For -l/-L, -0 NUL-terminates each file name (no newline) so the list is
    // safe for `xargs -0`. Other modes keep newline-separated records (with -0
    // the NUL appears only as the in-record file-name separator).
    //
    // Written in byte-bounded chunks, never as one join of everything: with
    // enough (or long enough) result lines a single joined string exceeds
    // V8's maximum string length and crashes — observed with 40k matches on
    // an 8 MB minified line. Writes queue; process.exitCode (not exit())
    // keeps them flush-safe.
    const nulList = opts.nul && (opts.filesWithMatches || opts.filesWithoutMatch);
    const CHUNK_BYTES = 32 << 20;             // ~32 MB per write
    let batch = [];
    let bytes = 0;
    const flush = () => {
      if (!batch.length) return;
      process.stdout.write(nulList ? batch.map(s => s + '\0').join('')
        : batch.join('\n') + '\n');
      batch = [];
      bytes = 0;
    };
    for (const line of out) {
      batch.push(line);
      bytes += line.length + 1;
      if (bytes >= CHUNK_BYTES) flush();
    }
    flush();
  }
  // Normally success means "a match was found". With -L it means "a file
  // without a match was printed", which is decoupled from the match total.
  // Set exitCode rather than calling process.exit(): stdout writes to a pipe
  // are async, and exit() would drop whatever hasn't flushed yet, truncating
  // large result sets mid-stream.
  const success = opts.filesWithoutMatch ? out.length > 0 : total > 0;
  process.exitCode = success ? 0 : 1;
}

main();
